'use strict';

// Market simulator + UI wiring — the browser equivalent of src/main.cpp.
// Everything runs client-side; there is no server behind this page.

const $  = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-IN');

const REF = 250000;          // Rs. 2500.00
const DEPTH_LEVELS = 14;

const roundTick = (p) => Math.floor(p / TICK) * TICK;
const fmt = (p) => (p / 100).toFixed(2);

// xorshift32 — called millions of times during a burst, so it must be cheap.
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

let burstLeft = 0, burstTotal = 0, burstStart = REF, burstMs = 0, burstDone = 0;
let burstRate = 0, burstOrders = 0, bestRate = 0, burstRunning = false;

function reprice() {
  const bb = book.bestBidPrice(), ba = book.bestAskPrice();
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
  book.tradeCount = 0;
  book.volume = 0;
  book.tapeN = 0;
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

// One-way panic flow with the reference price dragged down 10% across the burst.
//
// This mirrors crash() in bench/bench.cpp exactly — same three-way split, same
// price walk — so the number this prints can be read against the C++ number in
// the README. Timed over engine work only, as the C++ benchmark is.
function burstChunk(n) {
  const take = burstLeft < n ? burstLeft : n;
  const base = burstTotal - burstLeft;
  let id = nextId;

  const t0 = performance.now();
  for (let i = 0; i < take; i++) {
    const ref = roundTick(burstStart * (1 - 0.10 * ((base + i) / burstTotal)));
    const r   = rnd(100);

    if (r < 55)      book.submit(id++, SELL, LIMIT,  ref - rnd(20) * TICK,      10 + rnd(500));
    else if (r < 70) book.submit(id++, SELL, MARKET, 0,                          10 + rnd(200));
    else             book.submit(id++, BUY,  LIMIT,  ref - (2 + rnd(60)) * TICK, 10 + rnd(500));
  }
  const dt = performance.now() - t0;

  nextId = id;
  burstLeft -= take;
  burstMs   += dt;
  burstDone += take;
  return take;
}

// Runs the burst on its own timer so chunk size, not the 10 Hz render tick,
// sets how much work each slice does.
function burstPump() {
  if (burstLeft <= 0) { burstRunning = false; return; }
  ordersWindow += burstChunk(100000);
  reprice();

  if (burstLeft === 0) {
    burstRate   = burstDone / (burstMs / 1000);
    burstOrders = burstDone;
    if (burstRate > bestRate) bestRate = burstRate;
    burstRunning = false;
    render();
    return;
  }
  render();
  setTimeout(burstPump, 0);
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

  const bb = book.bestBidPrice(), ba = book.bestAskPrice();

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

  $('tape').innerHTML = book.tapeSnapshot(25).map(t =>
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
      `<b>${(burstRate / 1e6).toFixed(2)}M</b> orders/sec &nbsp;·&nbsp; ` +
      `best ${(bestRate / 1e6).toFixed(2)}M<br>` +
      `<span class="sub">${nf.format(burstOrders)} orders, measured in this browser</span>`;
  }
}

// Tracks resting quantity of orders placed from the ticket.
function syncMine() {
  for (const m of mine) {
    if (!m.live) continue;
    const left = book.qtyOf(m.id);
    if (left === 0) { m.filled += m.qty; m.qty = 0; m.live = false; }
    else { m.filled += m.qty - left; m.qty = left; }
  }
}

function submitUser(sideStr, typeStr, priceRs, qty) {
  if (!(qty > 0)) return;
  const s = sideStr === 'sell' ? SELL : BUY;
  const t = typeStr === 'market' ? MARKET : typeStr === 'ioc' ? IOC : LIMIT;
  const px = roundTick(Math.round(priceRs * 100));
  const id = nextId++;

  const status = book.submit(id, s, t, px, qty);
  ordersWindow++;

  mine.push({
    id,
    s: s === BUY ? 'BUY' : 'SELL',
    price: t === MARKET ? 0 : px,
    qty: book.lastResting,
    filled: book.lastFilled,
    live: status === S_RESTING,
  });
  if (mine.length > 40) mine.shift();
  reprice();
  render();
}

// ---------------------------------------------------------------- main loop
setInterval(() => {
  if (!burstRunning && autoFlow) {
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
  if (!burstRunning) render();
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
  if (burstRunning) return;

  // bench.cpp seeds 2000 levels a side before starting its clock; match that
  // so the burst runs against a book of the same depth. Untimed, as there.
  for (let i = 1; i <= 2000; i++) {
    book.submit(nextId++, BUY,  LIMIT, mid - i * TICK, 200);
    book.submit(nextId++, SELL, LIMIT, mid + i * TICK, 200);
  }

  burstTotal = parseInt($('burstN').value, 10);
  burstLeft  = burstTotal;
  burstDone  = 0;
  burstMs    = 0;
  burstStart = mid;
  burstRunning = true;
  $('burst').textContent = 'firing…';
  setTimeout(burstPump, 0);
};

$('reset').onclick = () => { seed(); render(); };
$('flow').onchange = () => { autoFlow = $('flow').checked; };

seed();
render();
