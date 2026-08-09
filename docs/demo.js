'use strict';

// Market simulator + UI wiring — the browser equivalent of src/main.cpp.
// Everything runs client-side; there is no server behind this page.

const $  = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-IN');

const TICK = 5;              // 5 paise, NSE equity tick
const REF  = 250000;         // Rs. 2500.00
const DEPTH_LEVELS = 14;

const roundTick = (p) => Math.floor(p / TICK) * TICK;
const fmt = (p) => (p / 100).toFixed(2);

// xorshift32 — the burst calls this millions of times, so it must be cheap.
let rngState = 0x9e3779b9;
function rnd(n) {
  rngState ^= rngState << 13; rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;  rngState >>>= 0;
  return rngState % n;
}

const book = new OrderBook();
let nextId = 1;
let mid = REF;
let mine = [];
let lastPx = null;

let autoFlow = true;
let side = 'buy';
let ordersWindow = 0;
let windowStart = performance.now();
let rate = 0;

let burstLeft = 0, burstTotal = 0, burstStart = REF, burstNs = 0, burstDone = 0;
let burstRate = 0, burstOrders = 0;

function reprice() {
  const bb = book.bestBid(), ba = book.bestAsk();
  if (bb && ba) mid = roundTick((bb + ba) / 2);
  else if (bb)  mid = bb;
  else if (ba)  mid = ba;
}

function seed() {
  book.clear();
  nextId = 1;
  mine = [];
  mid = REF;
  lastPx = null;
  burstOrders = 0; burstRate = 0;
  for (let i = 1; i <= 60; i++) {
    book.submit(nextId++, BUY,  LIMIT, mid - i * TICK, 25 + rnd(400));
    book.submit(nextId++, SELL, LIMIT, mid + i * TICK, 25 + rnd(400));
  }
  book.tape.length = 0;
  book.tradeCount = 0;
  book.volume = 0;
  reprice();
}

// Background flow so the tape and ladder are never static.
function ambient(n) {
  for (let i = 0; i < n; i++) {
    const buy = rnd(2) === 0;
    const off = rnd(25) - 8;                       // negative offsets cross
    const px  = roundTick(mid + (buy ? -off : off) * TICK);
    book.submit(nextId++, buy ? BUY : SELL, LIMIT, px, 10 + rnd(300));
  }
  reprice();
}

// One-way panic flow with the reference price dragged down 10% over the burst.
function burstChunk(n) {
  const take = Math.min(n, burstLeft);
  const t0 = performance.now();

  for (let i = 0; i < take; i++) {
    const done = burstTotal - burstLeft + i;
    const ref  = roundTick(burstStart * (1 - 0.10 * (done / burstTotal)));
    const r    = rnd(100);

    if (r < 55)      book.submit(nextId++, SELL, LIMIT,  ref - rnd(20) * TICK,      10 + rnd(500));
    else if (r < 70) book.submit(nextId++, SELL, MARKET, 0,                          10 + rnd(200));
    else if (r < 95) book.submit(nextId++, BUY,  LIMIT,  ref - (2 + rnd(60)) * TICK, 10 + rnd(500));
    else             book.submit(nextId++, BUY,  LIMIT,  ref + rnd(15) * TICK,       10 + rnd(300));
  }

  burstLeft -= take;
  burstNs   += performance.now() - t0;
  burstDone += take;

  if (burstLeft === 0 && burstDone > 0) {
    burstRate   = burstDone / (burstNs / 1000);
    burstOrders = burstDone;
  }
  reprice();
  return take;
}

function ladder(el, rows, cls, maxQty) {
  el.innerHTML = rows.map(([p, q, o]) => {
    const w = Math.max(2, (q / maxQty) * 100);
    const cells = cls === 'bid'
      ? `<span class="o">${o}</span><span>${nf.format(q)}</span><span class="p">${fmt(p)}</span>`
      : `<span class="p">${fmt(p)}</span><span>${nf.format(q)}</span><span class="o">${o}</span>`;
    return `<div class="lvl ${cls}" data-px="${fmt(p)}"><div class="bar" style="width:${w}%"></div>${cells}</div>`;
  }).join('');
}

function render() {
  const bids = book.depth(BUY,  DEPTH_LEVELS);
  const asks = book.depth(SELL, DEPTH_LEVELS);

  let maxQty = 1;
  for (const l of bids) if (l[1] > maxQty) maxQty = l[1];
  for (const l of asks) if (l[1] > maxQty) maxQty = l[1];

  const bb = book.bestBid(), ba = book.bestAsk();

  $('rate').textContent   = nf.format(Math.round(rate));
  $('live').textContent   = nf.format(book.liveOrders);
  $('levels').textContent = nf.format(book.levelCount);
  $('trades').textContent = nf.format(book.tradeCount);
  $('volume').textContent = nf.format(book.volume);
  $('spread').textContent = (bb && ba) ? fmt(ba - bb) : '—';

  const px = book.last || mid;
  const el = $('last');
  el.textContent = fmt(px);
  el.classList.toggle('up',   lastPx !== null && px > lastPx);
  el.classList.toggle('down', lastPx !== null && px < lastPx);
  lastPx = px;

  const pct = ((px - REF) / REF) * 100;
  const chg = $('chg');
  chg.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs open`;
  chg.className = `chg ${pct >= 0 ? 'up' : 'down'}`;

  ladder($('bids'), bids, 'bid', maxQty);
  ladder($('asks'), asks, 'ask', maxQty);

  $('tape').innerHTML = book.tape.map(t =>
    `<div class="t ${t.s === BUY ? 'B' : 'S'}"><span class="p">${fmt(t.p)}</span>` +
    `<span>${nf.format(t.q)}</span><span class="s">${t.s === BUY ? 'BUY' : 'SELL'}</span></div>`
  ).join('');

  const shown = mine.slice(-12).reverse();
  $('mine').innerHTML = shown.length ? shown.map(m =>
    `<div class="m ${m.live ? '' : 'done'}">
       <span class="side ${m.s}">${m.s}</span>
       <span>${m.price ? fmt(m.price) : 'MKT'}</span>
       <span>${nf.format(m.filled)}/${nf.format(m.filled + m.qty)}</span>
       ${m.live ? `<button class="x" data-cancel="${m.id}">×</button>` : '<span></span>'}
     </div>`).join('') : '<div class="empty">No orders yet</div>';

  if (burstLeft > 0) {
    $('burst').innerHTML = `draining… ${nf.format(burstLeft)} orders left`;
  } else if (burstOrders > 0) {
    $('burst').innerHTML =
      `<b>${(burstRate / 1e6).toFixed(2)}M</b> orders/sec sustained<br>` +
      `over ${nf.format(burstOrders)} orders (measured in this browser)`;
  }
}

// Tracks resting quantity of the orders placed from the ticket. The book emits
// aggregate trades, so quantities are reconciled from the id index.
function syncMine() {
  for (const m of mine) {
    if (!m.live) continue;
    const slot = book.index.get(m.id);
    if (slot === undefined) { m.filled += m.qty; m.qty = 0; m.live = false; }
    else {
      const left = book.oQty[slot];
      m.filled += m.qty - left;
      m.qty = left;
    }
  }
}

function submitUser(sideStr, typeStr, priceRs, qty) {
  if (!(qty > 0)) return;
  const s = sideStr === 'sell' ? SELL : BUY;
  const t = typeStr === 'market' ? MARKET : typeStr === 'ioc' ? IOC : LIMIT;
  const px = roundTick(Math.round(priceRs * 100));
  const id = nextId++;

  const rep = book.submit(id, s, t, px, qty);
  ordersWindow++;

  mine.push({
    id,
    s: s === BUY ? 'BUY' : 'SELL',
    price: t === MARKET ? 0 : px,
    qty: rep.resting,
    filled: rep.filled,
    live: rep.status === 'resting',
  });
  if (mine.length > 40) mine.shift();
  reprice();
  render();
}

// ---------------------------------------------------------------- main loop
setInterval(() => {
  if (burstLeft > 0) {
    ordersWindow += burstChunk(40000);
  } else if (autoFlow) {
    ambient(40);
    ordersWindow += 40;
  }
  syncMine();

  const now = performance.now();
  const elapsed = (now - windowStart) / 1000;
  if (elapsed >= 0.25) {
    rate = ordersWindow / elapsed;
    ordersWindow = 0;
    windowStart = now;
  }
  render();
}, 100);

// ---------------------------------------------------------------- UI wiring
$('bids').onclick = $('asks').onclick = (e) => {
  const lvl = e.target.closest('.lvl');
  if (lvl) $('price').value = lvl.dataset.px;
};

$('mine').onclick = (e) => {
  const id = e.target.dataset && e.target.dataset.cancel;
  if (!id) return;
  if (book.cancel(Number(id))) {
    const m = mine.find(x => x.id === Number(id));
    if (m) m.live = false;
    render();
  }
};

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    side = tab.dataset.side;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    const btn = $('submit');
    btn.className = `submit ${side}`;
    btn.textContent = side.toUpperCase();
  };
});

$('type').onchange = () => {
  const market = $('type').value === 'market';
  $('price').disabled = market;
  $('hint').textContent = market
    ? 'Market order — sweeps the book from the best price outwards'
    : 'Tick size 0.05 · prices snap to the tick';
};

$('submit').onclick = () =>
  submitUser(side, $('type').value, parseFloat($('price').value) || 0, parseInt($('qty').value, 10) || 0);

$('crash').onclick = () => {
  burstTotal = parseInt($('burstN').value, 10);
  burstLeft  = burstTotal;
  burstDone  = 0;
  burstNs    = 0;
  burstStart = mid;
  $('burst').textContent = 'firing…';
};

$('reset').onclick = () => { seed(); render(); };
$('flow').onchange = () => { autoFlow = $('flow').checked; };

seed();
render();
