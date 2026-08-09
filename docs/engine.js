'use strict';

// Browser port of include/order_book.hpp — same data structures, so the demo
// behaves like the C++ engine rather than faking it:
//
//   price levels : sorted price array + Map  (C++: std::map / red-black tree)
//   time queue   : intrusive doubly linked list, O(1) push-back / pop-front
//   id lookup    : Map<id, slot>             (C++: unordered_map) — O(1) cancel
//   order storage: typed-array slab + freelist, no allocation on the hot path
//
// Links are slot indices, not object references, exactly as in the C++ version.

const NIL = -1;
const BUY = 0, SELL = 1;
const LIMIT = 0, MARKET = 1, IOC = 2;

class OrderBook {
  constructor(cap = 1 << 18) {
    this._sizeArrays(cap);
    this.n     = 0;      // slab high-water mark
    this.free  = [];     // recycled slots
    this.index = new Map();

    this.bidLv = new Map();  // price -> {head, tail, qty, orders}
    this.askLv = new Map();
    this.bidPx = [];         // descending — bidPx[0] is the best bid
    this.askPx = [];         // ascending  — askPx[0] is the best ask

    this.tradeCount = 0;
    this.volume     = 0;
    this.last       = 0;
    this.tape       = [];    // most recent first, capped
    this.tapeMax    = 25;
  }

  _sizeArrays(cap) {
    this.cap    = cap;
    this.oId    = new Float64Array(cap);  // ids outgrow int32 during a burst
    this.oPx    = new Int32Array(cap);
    this.oQty   = new Int32Array(cap);
    this.oPrev  = new Int32Array(cap);
    this.oNext  = new Int32Array(cap);
    this.oSide  = new Uint8Array(cap);
  }

  _grow() {
    const c = this.cap * 2;
    const id = new Float64Array(c); id.set(this.oId);   this.oId   = id;
    const px = new Int32Array(c);   px.set(this.oPx);   this.oPx   = px;
    const qt = new Int32Array(c);   qt.set(this.oQty);  this.oQty  = qt;
    const pv = new Int32Array(c);   pv.set(this.oPrev); this.oPrev = pv;
    const nx = new Int32Array(c);   nx.set(this.oNext); this.oNext = nx;
    const sd = new Uint8Array(c);   sd.set(this.oSide); this.oSide = sd;
    this.cap = c;
  }

  _slot() {
    if (this.free.length) return this.free.pop();
    if (this.n >= this.cap) this._grow();
    return this.n++;
  }

  // Price arrays stay sorted so the best price is always index 0.
  _insertPx(arr, px, desc) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (desc ? arr[mid] > px : arr[mid] < px) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, px);
  }

  _removePx(arr, px, desc) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] === px) { arr.splice(mid, 1); return; }
      if (desc ? arr[mid] > px : arr[mid] < px) lo = mid + 1; else hi = mid;
    }
  }

  // Reuses tape objects — a burst produces hundreds of thousands of trades and
  // allocating one object each would drown the run in GC.
  _tape(p, q, s) {
    const t = this.tape;
    if (t.length < this.tapeMax) { t.unshift({ p, q, s }); return; }
    const e = t.pop();
    e.p = p; e.q = q; e.s = s;
    t.unshift(e);
  }

  submit(id, side, type, price, qty) {
    if (qty <= 0)           return { filled: 0, resting: 0, status: 'rejected' };
    if (this.index.has(id)) return { filled: 0, resting: 0, status: 'rejected' };

    const oppLv = side === BUY ? this.askLv : this.bidLv;
    const oppPx = side === BUY ? this.askPx : this.bidPx;
    if (type === MARKET && oppPx.length === 0)
      return { filled: 0, resting: 0, status: 'nobook' };

    const incoming = qty;
    const left = this._match(oppLv, oppPx, side, type, price, qty);

    if (left === 0) return { filled: incoming, resting: 0, status: 'filled' };
    if (type === LIMIT) {
      this._rest(id, side, price, left);
      return { filled: incoming - left, resting: left, status: 'resting' };
    }
    return { filled: incoming - left, resting: 0, status: 'cancelled' };
  }

  // Walks the opposite side from the best price outwards, FIFO within a level.
  _match(lvMap, pxArr, side, type, limit, qty) {
    while (qty > 0 && pxArr.length) {
      const px = pxArr[0];
      if (type !== MARKET) {
        const crosses = side === BUY ? px <= limit : px >= limit;
        if (!crosses) break;
      }

      const lv = lvMap.get(px);
      while (qty > 0 && lv.head !== NIL) {
        const r = lv.head;
        const fill = Math.min(qty, this.oQty[r]);

        this.oQty[r] -= fill;
        qty          -= fill;
        lv.qty       -= fill;

        this.tradeCount++;
        this.volume += fill;
        this.last    = px;
        this._tape(px, fill, side);

        if (this.oQty[r] === 0) {
          lv.head = this.oNext[r];
          if (lv.head !== NIL) this.oPrev[lv.head] = NIL; else lv.tail = NIL;
          lv.orders--;
          this.index.delete(this.oId[r]);
          this.free.push(r);
        }
      }

      if (lv.head === NIL) { lvMap.delete(px); pxArr.shift(); }
    }
    return qty;
  }

  _rest(id, side, px, qty) {
    const i = this._slot();
    this.oId[i] = id; this.oPx[i] = px; this.oQty[i] = qty;
    this.oPrev[i] = NIL; this.oNext[i] = NIL; this.oSide[i] = side;

    const buy = side === BUY;
    const map = buy ? this.bidLv : this.askLv;
    const arr = buy ? this.bidPx : this.askPx;

    let lv = map.get(px);
    if (!lv) {
      lv = { head: NIL, tail: NIL, qty: 0, orders: 0 };
      map.set(px, lv);
      this._insertPx(arr, px, buy);
    }

    if (lv.tail === NIL) lv.head = i;
    else { this.oNext[lv.tail] = i; this.oPrev[i] = lv.tail; }
    lv.tail = i;
    lv.qty += qty;
    lv.orders++;

    this.index.set(id, i);
  }

  cancel(id) {
    const i = this.index.get(id);
    if (i === undefined) return false;

    const px  = this.oPx[i];
    const buy = this.oSide[i] === BUY;
    const map = buy ? this.bidLv : this.askLv;
    const arr = buy ? this.bidPx : this.askPx;
    const lv  = map.get(px);

    const p = this.oPrev[i], nx = this.oNext[i];
    if (p  !== NIL) this.oNext[p]  = nx; else lv.head = nx;
    if (nx !== NIL) this.oPrev[nx] = p;  else lv.tail = p;
    lv.qty -= this.oQty[i];
    lv.orders--;

    if (lv.head === NIL) { map.delete(px); this._removePx(arr, px, buy); }

    this.index.delete(id);
    this.free.push(i);
    return true;
  }

  bestBid() { return this.bidPx.length ? this.bidPx[0] : 0; }
  bestAsk() { return this.askPx.length ? this.askPx[0] : 0; }

  depth(side, levels) {
    const buy = side === BUY;
    const arr = buy ? this.bidPx : this.askPx;
    const map = buy ? this.bidLv : this.askLv;
    const out = [];
    for (let i = 0; i < arr.length && out.length < levels; i++) {
      const lv = map.get(arr[i]);
      out.push([arr[i], lv.qty, lv.orders]);
    }
    return out;
  }

  get liveOrders() { return this.index.size; }
  get levelCount() { return this.bidPx.length + this.askPx.length; }

  clear() {
    this._sizeArrays(1 << 18);
    this.n = 0;
    this.free.length = 0;
    this.index.clear();
    this.bidLv.clear(); this.askLv.clear();
    this.bidPx.length = 0; this.askPx.length = 0;
    this.tradeCount = 0; this.volume = 0; this.last = 0;
    this.tape.length = 0;
  }
}
