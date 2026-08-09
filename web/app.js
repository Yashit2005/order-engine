const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('en-IN');

let side = 'buy';
let ws = null;
let lastPx = null;

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => $('conn').classList.add('on');
  ws.onclose = () => { $('conn').classList.remove('on'); setTimeout(connect, 1000); };
  ws.onmessage = (e) => render(JSON.parse(e.data));
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function ladder(el, rows, cls, maxQty) {
  el.innerHTML = rows.map(([p, q, o]) => {
    const w = Math.max(2, (q / maxQty) * 100);
    const cells = cls === 'bid'
      ? `<span class="o">${o}</span><span>${nf.format(q)}</span><span class="p">${p}</span>`
      : `<span class="p">${p}</span><span>${nf.format(q)}</span><span class="o">${o}</span>`;
    return `<div class="lvl ${cls}" data-px="${p}"><div class="bar" style="width:${w}%"></div>${cells}</div>`;
  }).join('');
}

function render(s) {
  $('rate').textContent = nf.format(s.rate);
  $('live').textContent = nf.format(s.live);
  $('levels').textContent = nf.format(s.levels);
  $('trades').textContent = nf.format(s.trades);
  $('volume').textContent = nf.format(s.volume);
  $('lat').textContent = s.lat ? `${nf.format(s.lat)} ns` : '— ns';
  $('spread').textContent = s.spread;

  const px = parseFloat(s.last);
  const el = $('last');
  el.textContent = s.last;
  el.classList.toggle('up', lastPx !== null && px > lastPx);
  el.classList.toggle('down', lastPx !== null && px < lastPx);
  lastPx = px;

  const ref = parseFloat(s.ref);
  const pct = ((px - ref) / ref) * 100;
  const chg = $('chg');
  chg.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs open`;
  chg.className = `chg ${pct >= 0 ? 'up' : 'down'}`;

  ladder($('bids'), s.bids, 'bid', s.maxQty);
  ladder($('asks'), s.asks, 'ask', s.maxQty);

  $('tape').innerHTML = s.tape.map(t =>
    `<div class="t ${t.s}"><span class="p">${t.p}</span><span>${nf.format(t.q)}</span><span class="s">${t.s === 'B' ? 'BUY' : 'SELL'}</span></div>`
  ).join('');

  $('mine').innerHTML = s.mine.length ? s.mine.map(m =>
    `<div class="m ${m.live ? '' : 'done'}">
       <span class="side ${m.s}">${m.s}</span>
       <span>${m.p}</span>
       <span>${nf.format(m.f)}/${nf.format(m.f + m.q)}</span>
       ${m.live ? `<button class="x" data-cancel="${m.id}">×</button>` : '<span></span>'}
     </div>`).join('') : '<div class="empty">No orders yet</div>';

  if (s.burstLeft > 0) {
    $('burst').innerHTML = `draining… ${nf.format(s.burstLeft)} orders left`;
  } else if (s.burstOrders > 0) {
    $('burst').innerHTML =
      `<b>${(s.burstRate / 1e6).toFixed(2)}M</b> orders/sec sustained<br>over ${nf.format(s.burstOrders)} orders (measured)`;
  }
}

$('bids').onclick = $('asks').onclick = (e) => {
  const lvl = e.target.closest('.lvl');
  if (lvl) $('price').value = lvl.dataset.px;
};

$('mine').onclick = (e) => {
  const id = e.target.dataset?.cancel;
  if (id) send({ cmd: 'cancel', id: Number(id) });
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

$('submit').onclick = () => {
  send({
    cmd: 'new',
    side,
    type: $('type').value,
    price: parseFloat($('price').value) || 0,
    qty: parseInt($('qty').value, 10) || 0,
  });
};

$('crash').onclick = () => {
  $('burst').textContent = 'firing…';
  send({ cmd: 'crash', orders: parseInt($('burstN').value, 10) });
};

$('reset').onclick = () => { lastPx = null; send({ cmd: 'reset' }); };
$('flow').onchange = () => send({ cmd: 'flow', on: $('flow').checked ? 1 : 0 });

connect();
