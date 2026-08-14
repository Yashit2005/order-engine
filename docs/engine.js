'use strict';

// Browser port of the C++ order book, tuned for the browser's constraints.
//
// The C++ engine keeps price levels in a std::map so it can quote any price.
// A browser demo runs inside a known price band, so this port takes the
// alternative the README names: levels live in a FLAT ARRAY INDEXED BY TICK.
// That removes every tree walk, every sorted-array splice and every hash of a
// price — the book becomes pointer arithmetic.
//
//   price levels : Int32Array indexed by (price - BAND_LO) / TICK
//   time queue   : intrusive doubly linked list, O(1) push-back / pop-front
//   id lookup    : open-addressed Int32Array table + Map spill — O(1) cancel
//   order storage: typed-array slab + freelist, zero allocation on the hot path
//
// Everything is a slot index; nothing on the matching path allocates.

const NIL = -1;
const BUY = 0, SELL = 1;
const LIMIT = 0, MARKET = 1, IOC = 2;

// submit() returns a status code instead of an object — allocating a result
// per order costs more than the matching does.
const S_REJECTED = 0, S_FILLED = 1, S_RESTING = 2, S_CANCELLED = 3, S_NOBOOK = 4;

const TICK    = 5;        // 5 paise
const BAND_LO = 100000;   // Rs. 1000.00
const BAND_HI = 400000;   // Rs. 4000.00
const NTICKS  = (BAND_HI - BAND_LO) / TICK;

const ID_SIZE = 1 << 21;  // id -> slot table, wraps after 2M submissions
const ID_MASK = ID_SIZE - 1;

const tickOf  = (px) => { const t = ((px - BAND_LO) / TICK) | 0; return t < 0 ? 0 : (t >= NTICKS ? NTICKS - 1 : t); };
const priceOf = (t)  => BAND_LO + t * TICK;

class OrderBook {
  constructor(cap = 1 << 19) {
    this._sizeOrders(cap);

    this.lvHead = new Int32Array(NTICKS).fill(NIL);
    this.lvTail = new Int32Array(NTICKS).fill(NIL);
    this.lvQty  = new Int32Array(NTICKS);
    this.lvOrd  = new Int32Array(NTICKS);

    // A tick is only ever one-sided: a resting bid above the best ask would
    // have crossed, so bids and asks can share one level array.
    this.bestBid = -1;
    this.bestAsk = NTICKS;

    this.idSlot = new Int32Array(ID_SIZE);  // 0 = empty, else slot + 1
    this.spill  = new Map();                // collisions only

    this.tapeP = new Int32Array(32);
    this.tapeQ = new Int32Array(32);
    this.tapeS = new Uint8Array(32);
    this.tapeN = 0;

    this.tradeCount = 0;
    this.volume     = 0;
    this.last       = 0;
    this.live       = 0;
    this.levels     = 0;

    this.lastFilled  = 0;
    this.lastResting = 0;
  }

  _sizeOrders(cap) {
    this.cap   = cap;
    this.oId   = new Int32Array(cap);   // ids stay well under 2^31
    this.oQty  = new Int32Array(cap);
    this.oPrev = new Int32Array(cap);
    this.oNext = new Int32Array(cap);
    this.oTick = new Int32Array(cap);
    this.oSide = new Uint8Array(cap);
    this.free  = new Int32Array(cap);
    this.freeN = 0;
    this.n     = 0;
  }

  _grow() {
    const c = this.cap * 2;
    const id = new Int32Array(c);   id.set(this.oId);   this.oId   = id;
    const qt = new Int32Array(c);   qt.set(this.oQty);  this.oQty  = qt;
    const pv = new Int32Array(c);   pv.set(this.oPrev); this.oPrev = pv;
    const nx = new Int32Array(c);   nx.set(this.oNext); this.oNext = nx;
    const tk = new Int32Array(c);   tk.set(this.oTick); this.oTick = tk;
    const sd = new Uint8Array(c);   sd.set(this.oSide); this.oSide = sd;
    const fr = new Int32Array(c);   fr.set(this.free);  this.free  = fr;
    this.cap = c;
  }

  _slot() {
    if (this.freeN > 0) return this.free[--this.freeN];
    if (this.n >= this.cap) this._grow();
    return this.n++;
  }

  // ------------------------------------------------------------- id index
  _bind(id, slot) {
    const b = id & ID_MASK;
    if (this.idSlot[b] === 0) this.idSlot[b] = slot + 1;
    else this.spill.set(id, slot);
  }

  _unbind(id, slot) {
    const b = id & ID_MASK;
    if (this.idSlot[b] === slot + 1) this.idSlot[b] = 0;
    else if (this.spill.size) this.spill.delete(id);
  }

  _find(id) {
    const s = this.idSlot[id & ID_MASK] - 1;
    if (s >= 0 && this.oId[s] === id) return s;
    const sp = this.spill.get(id);
    return sp === undefined ? NIL : sp;
  }

  // Best pointers are allowed to sit on an emptied level; they are walked
  // forward lazily rather than fixed up on every cancel.
  _fixBid() { let b = this.bestBid; const h = this.lvHead; while (b >= 0 && h[b] === NIL) b--; this.bestBid = b; return b; }
  _fixAsk() { let a = this.bestAsk; const h = this.lvHead; while (a < NTICKS && h[a] === NIL) a++; this.bestAsk = a; return a; }

  // ------------------------------------------------------------- matching
  submit(id, side, type, price, qty) {
    if (qty <= 0) { this.lastFilled = 0; this.lastResting = 0; return S_REJECTED; }

    const t = type === MARKET ? 0 : tickOf(price);

    if (type === MARKET) {
      const empty = side === BUY ? this._fixAsk() >= NTICKS : this._fixBid() < 0;
      if (empty) { this.lastFilled = 0; this.lastResting = 0; return S_NOBOOK; }
    }

    const incoming = qty;
    const left = side === BUY ? this._matchBuy(t, type, qty) : this._matchSell(t, type, qty);

    this.lastFilled = incoming - left;

    if (left === 0) { this.lastResting = 0; return S_FILLED; }
    if (type === LIMIT) {
      this._rest(id, side, t, left);
      this.lastResting = left;
      return S_RESTING;
    }
    this.lastResting = 0;
    return S_CANCELLED;
  }

  _matchBuy(limitTick, type, qty) {
    const lvHead = this.lvHead, lvTail = this.lvTail, lvQty = this.lvQty, lvOrd = this.lvOrd;
    const oQty = this.oQty, oNext = this.oNext, oPrev = this.oPrev, oId = this.oId;
    const tapeP = this.tapeP, tapeQ = this.tapeQ, tapeS = this.tapeS;
    const idSlot = this.idSlot, spill = this.spill;
    const market = type === MARKET;

    let a = this.bestAsk;
    let trades = this.tradeCount, vol = this.volume, last = this.last, tn = this.tapeN;
    let live = this.live, levels = this.levels, freeN = this.freeN;
    const free = this.free;

    while (qty > 0 && a < NTICKS) {
      if (lvHead[a] === NIL) { a++; continue; }
      if (!market && a > limitTick) break;

      const px = priceOf(a);
      let h = lvHead[a], lq = lvQty[a], lo = lvOrd[a];

      while (qty > 0 && h !== NIL) {
        const r  = h;
        const rq = oQty[r];
        const fill = qty < rq ? qty : rq;

        oQty[r] = rq - fill;
        qty -= fill;
        lq  -= fill;

        trades++; vol += fill; last = px;
        const ti = tn++ & 31;
        tapeP[ti] = px; tapeQ[ti] = fill; tapeS[ti] = BUY;

        if (rq === fill) {
          h = oNext[r];
          lo--; live--;
          const oid = oId[r], bkt = oid & ID_MASK;   // _unbind, inlined
          if (idSlot[bkt] === r + 1) idSlot[bkt] = 0; else spill.delete(oid);
          free[freeN++] = r;
        }
      }

      lvHead[a] = h;
      if (h !== NIL) oPrev[h] = NIL; else { lvTail[a] = NIL; levels--; }
      lvQty[a] = lq; lvOrd[a] = lo;
      if (h === NIL) a++;
    }

    this.bestAsk = a;
    this.tradeCount = trades; this.volume = vol; this.last = last; this.tapeN = tn;
    this.live = live; this.levels = levels; this.freeN = freeN;
    return qty;
  }

  _matchSell(limitTick, type, qty) {
    const lvHead = this.lvHead, lvTail = this.lvTail, lvQty = this.lvQty, lvOrd = this.lvOrd;
    const oQty = this.oQty, oNext = this.oNext, oPrev = this.oPrev, oId = this.oId;
    const tapeP = this.tapeP, tapeQ = this.tapeQ, tapeS = this.tapeS;
    const idSlot = this.idSlot, spill = this.spill;
    const market = type === MARKET;

    let b = this.bestBid;
    let trades = this.tradeCount, vol = this.volume, last = this.last, tn = this.tapeN;
    let live = this.live, levels = this.levels, freeN = this.freeN;
    const free = this.free;

    while (qty > 0 && b >= 0) {
      if (lvHead[b] === NIL) { b--; continue; }
      if (!market && b < limitTick) break;

      const px = priceOf(b);
      let h = lvHead[b], lq = lvQty[b], lo = lvOrd[b];

      while (qty > 0 && h !== NIL) {
        const r  = h;
        const rq = oQty[r];
        const fill = qty < rq ? qty : rq;

        oQty[r] = rq - fill;
        qty -= fill;
        lq  -= fill;

        trades++; vol += fill; last = px;
        const ti = tn++ & 31;
        tapeP[ti] = px; tapeQ[ti] = fill; tapeS[ti] = SELL;

        if (rq === fill) {
          h = oNext[r];
          lo--; live--;
          const oid = oId[r], bkt = oid & ID_MASK;   // _unbind, inlined
          if (idSlot[bkt] === r + 1) idSlot[bkt] = 0; else spill.delete(oid);
          free[freeN++] = r;
        }
      }

      lvHead[b] = h;
      if (h !== NIL) oPrev[h] = NIL; else { lvTail[b] = NIL; levels--; }
      lvQty[b] = lq; lvOrd[b] = lo;
      if (h === NIL) b--;
    }

    this.bestBid = b;
    this.tradeCount = trades; this.volume = vol; this.last = last; this.tapeN = tn;
    this.live = live; this.levels = levels; this.freeN = freeN;
    return qty;
  }

  _rest(id, side, t, qty) {
    const i = this._slot();
    this.oId[i] = id; this.oQty[i] = qty; this.oTick[i] = t; this.oSide[i] = side;
    this.oPrev[i] = NIL; this.oNext[i] = NIL;

    const tail = this.lvTail[t];
    if (tail === NIL) { this.lvHead[t] = i; this.levels++; }
    else { this.oNext[tail] = i; this.oPrev[i] = tail; }
    this.lvTail[t] = i;
    this.lvQty[t] += qty;
    this.lvOrd[t]++;

    if (side === BUY) { if (t > this.bestBid) this.bestBid = t; }
    else              { if (t < this.bestAsk) this.bestAsk = t; }

    this._bind(id, i);
    this.live++;
  }

  cancel(id) {
    const i = this._find(id);
    if (i === NIL) return false;

    const t = this.oTick[i];
    const p = this.oPrev[i], nx = this.oNext[i];

    if (p  !== NIL) this.oNext[p]  = nx; else this.lvHead[t] = nx;
    if (nx !== NIL) this.oPrev[nx] = p;  else this.lvTail[t] = p;

    this.lvQty[t] -= this.oQty[i];
    this.lvOrd[t]--;
    if (this.lvHead[t] === NIL) this.levels--;

    this._unbind(id, i);
    this.free[this.freeN++] = i;
    this.live--;
    return true;
  }

  // ------------------------------------------------------------- readers
  qtyOf(id)  { const i = this._find(id); return i === NIL ? 0 : this.oQty[i]; }
  isLive(id) { return this._find(id) !== NIL; }

  bestBidPrice() { const b = this._fixBid(); return b < 0 ? 0 : priceOf(b); }
  bestAskPrice() { const a = this._fixAsk(); return a >= NTICKS ? 0 : priceOf(a); }

  depth(side, n) {
    const out = [];
    if (side === BUY) {
      for (let t = this._fixBid(); t >= 0 && out.length < n; t--)
        if (this.lvHead[t] !== NIL) out.push([priceOf(t), this.lvQty[t], this.lvOrd[t]]);
    } else {
      for (let t = this._fixAsk(); t < NTICKS && out.length < n; t++)
        if (this.lvHead[t] !== NIL) out.push([priceOf(t), this.lvQty[t], this.lvOrd[t]]);
    }
    return out;
  }

  // Built only at render time (10 Hz), never on the matching path.
  tapeSnapshot(n) {
    const out = [];
    const count = this.tapeN < 32 ? this.tapeN : 32;
    for (let k = 1; k <= count && out.length < n; k++) {
      const i = (this.tapeN - k) & 31;
      out.push({ p: this.tapeP[i], q: this.tapeQ[i], s: this.tapeS[i] });
    }
    return out;
  }

  get liveOrders() { return this.live; }
  get levelCount() { return this.levels; }

  clear() {
    this._sizeOrders(1 << 19);
    this.lvHead.fill(NIL); this.lvTail.fill(NIL);
    this.lvQty.fill(0); this.lvOrd.fill(0);
    this.idSlot.fill(0); this.spill.clear();
    this.bestBid = -1; this.bestAsk = NTICKS;
    this.tradeCount = 0; this.volume = 0; this.last = 0;
    this.live = 0; this.levels = 0; this.tapeN = 0;
  }
}
