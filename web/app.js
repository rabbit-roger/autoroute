let data;
let version = 0;
const $ = id => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const PAGE = 50;
let page = 0;
const VH = 250;
const HOUR = 3600000;
const DAY = 86400000;

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'X-Autoroute-UI': '1', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error('Service unavailable.');
  return r;
}

/* ---------- formatting ---------- */
function usd(v) {
  if (v == null) return 'N/A';
  const sign = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 100) return sign + '$' + a.toFixed(0);
  if (a >= 1) return sign + '$' + a.toFixed(2);
  return sign + '$' + a.toFixed(3);
}
function signed(v) {
  return (v > 0 ? '+' : '') + usd(v);
}
function usdRange(r) {
  if (!r) return 'N/A';
  return (r.low === r.high ? '' : '~') + usd((r.low + r.high) / 2);
}
const num = v => v.toLocaleString('en-US');
const mid = r => (r.low + r.high) / 2;

/* ---------- data helpers ---------- */
function options(id, values) {
  const select = $(id), value = select.value;
  const first = select.options[0] ? select.options[0].text : 'All';
  select.replaceChildren(new Option(first, ''), ...values.filter(Boolean).sort().map(v => new Option(v, v)));
  select.value = value;
}
function filtered() {
  const project = $('project').value, app = $('app').value;
  const days = Number($('period').value);
  const since = days > 0 ? Date.now() - days * DAY : 0;
  return data.events.filter(e =>
    e.kind === 'request' &&
    (!project || e.project === project) &&
    (!app || e.app === app) &&
    Date.parse(e.timestamp) >= since);
}
const servedModel = e => e.observedModel || e.requestedModel;
const actualCost = e => (e.costs && e.costs[servedModel(e)]) || null;
function baselineCost(e) {
  let best = null;
  if (e.costs) for (const m in e.costs) { const c = e.costs[m]; if (c && (!best || c.high > best.high)) best = c; }
  return best;
}

/* ---------- SVG helpers ---------- */
function el(name, attrs, text) {
  const n = document.createElementNS(SVG, name);
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  if (text !== undefined) n.textContent = text;
  return n;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
function size(svg) {
  const w = Math.max(280, Math.floor(svg.getBoundingClientRect().width || 560));
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + VH);
  svg.setAttribute('height', String(VH));
  svg.replaceChildren();
  return w;
}
function empty(svg, message) {
  const w = size(svg);
  svg.append(el('text', { x: w / 2, y: VH / 2, 'text-anchor': 'middle', class: 'tick' }, message));
}
function axes(svg, plot, max, formatY) {
  for (let i = 0; i <= 4; i++) {
    const y = plot.top + plot.h - (plot.h * i) / 4;
    svg.append(el('line', { x1: plot.left, x2: plot.left + plot.w, y1: y, y2: y, class: 'grid' }));
    svg.append(el('text', { x: plot.left - 6, y: y + 5, 'text-anchor': 'end', class: 'tick' }, formatY((max * i) / 4)));
  }
}
const palette = models => new Map(models.map((m, i) => [m, 's' + (i % 5)]));

function bucketLabel(t, size) {
  const d = new Date(t);
  return size === HOUR
    ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ---------- charts ---------- */
function chartSpend(events) {
  const svg = $('chart-spend');
  const rows = events.map(e => ({ t: Date.parse(e.timestamp), model: servedModel(e), c: actualCost(e) })).filter(r => r.c);
  $('legend-spend').replaceChildren();
  if (!rows.length) return empty(svg, 'No priced requests yet');
  const lo = Math.min(...rows.map(r => r.t)), hi = Math.max(...rows.map(r => r.t));
  const span = hi - lo <= 48 * HOUR ? HOUR : DAY;
  const origin = Math.floor(lo / span) * span;
  const count = Math.floor((hi - origin) / span) + 1;
  const totals = new Map();
  for (const r of rows) totals.set(r.model, (totals.get(r.model) || 0) + mid(r.c));
  const models = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a));
  const colors = palette(models);
  const buckets = Array.from({ length: count }, () => new Map());
  const requests = Array(count).fill(0);
  for (const r of rows) {
    const i = Math.floor((r.t - origin) / span);
    buckets[i].set(r.model, (buckets[i].get(r.model) || 0) + mid(r.c));
    requests[i]++;
  }
  const sums = buckets.map(b => [...b.values()].reduce((a, v) => a + v, 0));
  const max = niceMax(Math.max(...sums));
  const W = size(svg);
  const plot = { left: 64, top: 10, w: W - 76, h: 190 };
  axes(svg, plot, max, usd);
  const slot = plot.w / count, width = Math.max(1, slot * 0.8);
  buckets.forEach((b, i) => {
    let y = plot.top + plot.h;
    for (const m of models) {
      const v = b.get(m);
      if (!v) continue;
      const h = (v / max) * plot.h;
      y -= h;
      const r = el('rect', { x: plot.left + i * slot + (slot - width) / 2, y, width, height: h, class: colors.get(m) });
      r.append(el('title', {}, bucketLabel(origin + i * span, span) + ' · ' + m + ' · ' + usd(v) + ' · ' + requests[i] + ' requests in bucket'));
      svg.append(r);
    }
  });
  const marks = count <= 2 ? [...Array(count).keys()] : [0, count - 1];
  for (const i of new Set(marks)) {
    svg.append(el('text', { x: plot.left + i * slot + slot / 2, y: VH - 6, 'text-anchor': 'middle', class: 'tick' }, bucketLabel(origin + i * span, span)));
  }
  for (const m of models) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.className = 'sw ' + colors.get(m);
    item.append(sw, document.createTextNode(m));
    $('legend-spend').append(item);
  }
}

function chartModels(events) {
  const svg = $('chart-models');
  const by = new Map();
  for (const e of events) {
    const m = servedModel(e);
    if (!m) continue;
    const row = by.get(m) || { n: 0, low: 0, high: 0, priced: 0 };
    row.n++;
    const c = actualCost(e);
    if (c) { row.low += c.low; row.high += c.high; row.priced++; }
    by.set(m, row);
  }
  if (!by.size) return empty(svg, 'No requests yet');
  const models = [...by.keys()].sort((a, b) => by.get(b).high - by.get(a).high || by.get(b).n - by.get(a).n);
  const colors = palette(models);
  const max = Math.max(...models.map(m => by.get(m).high), 1e-9);
  const total = events.length;
  const W = size(svg);
  const rowH = 66;
  const lim = Math.max(10, Math.floor((W - 200) / 8.5));
  svg.setAttribute('height', String(models.length * rowH + 4));
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + (models.length * rowH + 4));
  models.forEach((m, i) => {
    const r = by.get(m), y = i * rowH;
    const share = Math.round((r.n / total) * 100);
    svg.append(el('text', { x: 0, y: y + 18, class: 'label' }, m.length > lim ? m.slice(0, lim - 1) + '…' : m));
    svg.append(el('text', { x: W, y: y + 18, 'text-anchor': 'end', class: 'tick' }, (r.priced ? usdRange(r) : 'N/A') + ' · ' + r.n + ' req · ' + share + '%'));
    const w = Math.max(r.priced ? 3 : 0, (r.high / max) * W);
    svg.append(el('rect', { x: 0, y: y + 30, width: W, height: 14, class: 'track' }));
    const bar = el('rect', { x: 0, y: y + 30, width: w, height: 14, class: colors.get(m) });
    bar.append(el('title', {}, m + ' · ' + r.n + ' requests · ' + usdRange(r.priced ? r : null)));
    svg.append(bar);
  });
}

function chartSavings(events) {
  const svg = $('chart-savings');
  const rows = [];
  for (const e of events) {
    const a = actualCost(e), b = baselineCost(e);
    if (a && b) rows.push({ t: Date.parse(e.timestamp), a: mid(a), b: mid(b) });
  }
  if (rows.length < 2) return empty(svg, 'Needs at least two priced requests');
  rows.sort((x, y) => x.t - y.t);
  let ca = 0, cb = 0;
  const pts = rows.map(r => ({ t: r.t, a: (ca += r.a), b: (cb += r.b) }));
  const lo = pts[0].t, hi = pts[pts.length - 1].t || lo + 1;
  const max = niceMax(Math.max(ca, cb));
  const W = size(svg);
  const plot = { left: 64, top: 10, w: W - 76, h: 190 };
  axes(svg, plot, max, usd);
  const X = t => plot.left + (hi === lo ? 0 : ((t - lo) / (hi - lo)) * plot.w);
  const Y = v => plot.top + plot.h - (v / max) * plot.h;
  const line = (key, cls) => el('polyline', { points: pts.map(p => X(p.t).toFixed(1) + ',' + Y(p[key]).toFixed(1)).join(' '), class: cls });
  svg.append(line('b', 'l-base'), line('a', 'l-actual'));
  svg.append(el('text', { x: plot.left + plot.w, y: Y(cb) - 8, 'text-anchor': 'end', class: 'label base' }, 'most expensive model ' + usd(cb)));
  svg.append(el('text', { x: plot.left + plot.w, y: Y(ca) + 20, 'text-anchor': 'end', class: 'label actual' }, 'Autoroute ' + usd(ca)));
  const span = hi - lo <= 48 * HOUR ? HOUR : DAY;
  svg.append(el('text', { x: plot.left, y: VH - 6, class: 'tick' }, bucketLabel(lo, span)));
  svg.append(el('text', { x: plot.left + plot.w, y: VH - 6, 'text-anchor': 'end', class: 'tick' }, bucketLabel(hi, span)));
}

const REASONS = {
  'routing-off': 'Routing was switched off for this conversation, so the model and effort you chose yourself were used unchanged.',
  'hard-risk-floor': 'The task looked risky (deploys, deletes, security, payments, databases, production), so Autoroute used the strongest model.',
  'cache-switch-paid-back': 'A cheaper model was chosen even though it means re-reading the conversation, because the saving on this task is larger than that one-time cost.',
  'cache-switch-not-paid-back': 'A cheaper model was possible, but the current model kept its memory (cache) of the conversation. Switching would cost more than it saves on this task, so it stayed.',
  'cache-switch-context-unknown': 'A cheaper model was possible, but the size of the conversation was unknown, so the model was not changed.',
  'cache-switch-unpriced-large-context': 'A cheaper model was possible, but the conversation is large and a price for it is missing, so the model was not changed.',
  'cache-switch-unpriced-small-context': 'A cheaper model was chosen. Its price is missing, but the conversation is small, so switching is safe.',
  'cache-switch-price-range-unavailable': 'A cheaper model was possible, but the cost of switching could not be estimated, so the model was not changed.',
  'cache-cold-switch': 'The model had been idle long enough that its memory of the conversation expired, so switching models cost nothing extra.',
  'manual-model-pin': 'You picked the model yourself. Autoroute respects that choice until you run /autoroute-on again.',
  'manual-effort-pin': 'You picked the effort level yourself. Autoroute keeps it until you run /autoroute-on again.',
  'risk-floor-pin-conflict': 'You picked a model weaker than the task seems to need. Your choice was kept.',
  'unsupported-effort-pin': 'The effort you picked is not available on the chosen model, so it was not applied.',
  'no-confirmed-route': 'No verified model fits this task (for example an image is attached), so the model was left unchanged.',
  'host-version-unsupported': 'This Claude Code version is older than Autoroute supports, so nothing was changed. Update Claude Code.',
  'baseline-capability-unknown': 'The model you were using is not in the confirmed list, so nothing was changed.',
  observation: 'A request that was only observed, with no routing decision.',
};
function chartReasons(events) {
  const box = $('chart-reasons');
  box.replaceChildren();
  const counts = new Map();
  for (const e of events) {
    const list = (e.reasons || []).filter(r => !r.startsWith('complexity-') && !r.startsWith('activity-'));
    for (const r of list.length ? list : ['observation']) counts.set(r, (counts.get(r) || 0) + 1);
  }
  if (!counts.size) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No routing decisions recorded yet';
    box.append(p);
    return;
  }
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = list[0][1];
  for (const [name, n] of list) {
    const row = document.createElement('div');
    row.className = 'reason-row';
    const tip = document.createElement('span');
    tip.className = 'tip';
    tip.tabIndex = 0;
    tip.textContent = 'i';
    tip.setAttribute('data-tip', REASONS[name] || 'An internal routing code without a description yet.');
    tip.setAttribute('aria-label', 'Explanation');
    const label = document.createElement('span');
    label.className = 'rname';
    label.textContent = name;
    const bar = document.createElement('span');
    bar.className = 'rbar';
    const fill = document.createElement('i');
    fill.style.width = Math.max(2, (n / max) * 100) + '%';
    bar.append(fill);
    const count = document.createElement('span');
    count.className = 'rcount';
    count.textContent = String(n);
    row.append(tip, label, bar, count);
    box.append(row);
  }
}

/* ---------- cards and table ---------- */
function cards(events, tasks) {
  $('requests').textContent = String(events.length);
  const measured = k => events.map(e => e.usage && e.usage[k]).filter(v => v != null);
  const sum = k => { const v = measured(k); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const input = sum('input'), output = sum('output'), read = sum('cacheRead'), write = sum('cacheWrite');
  $('tokens').textContent = input === null ? 'N/A' : num(input) + ' / ' + (output === null ? 'N/A' : num(output));
  $('cache').textContent = read === null ? 'N/A' : num(read) + ' read / ' + (write === null ? 'N/A' : num(write)) + ' written';
  const full = events.filter(e => e.usage && e.usage.input != null && e.usage.cacheRead != null && e.usage.cacheWrite != null);
  const prompt = full.reduce((a, e) => a + e.usage.input + e.usage.cacheRead + e.usage.cacheWrite, 0);
  const cached = full.reduce((a, e) => a + e.usage.cacheRead, 0);
  $('hit').textContent = prompt ? Math.round((cached / prompt) * 100) + '%' : 'N/A';
  const counted = events.filter(e => e.usage && e.usage.input != null && e.usage.output != null).length;
  $('coverage').textContent = events.length ? counted + '/' + events.length : 'N/A';
  $('requests-sub').textContent = events.length ? num(new Set(events.map(e => e.taskId).filter(Boolean)).size) + ' tasks' : ' ';

  let low = 0, high = 0, priced = 0;
  for (const e of events) {
    const c = actualCost(e);
    if (c) { low += c.low; high += c.high; priced++; }
  }
  $('spend').textContent = priced ? usdRange({ low, high }) : 'N/A';
  $('spend-sub').textContent = events.length ? priced + '/' + events.length + ' requests priced' : ' ';

  let bl = 0, bh = 0, al = 0, ah = 0, both = 0;
  for (const e of events) {
    const a = actualCost(e), b = baselineCost(e);
    if (a && b) { al += a.low; ah += a.high; bl += b.low; bh += b.high; both++; }
  }
  if (both) {
    const savedLow = Math.min(bl - ah, bh - al), savedHigh = Math.max(bl - ah, bh - al);
    $('savings').textContent = (savedLow === savedHigh ? '' : '~') + signed((savedLow + savedHigh) / 2);
    $('savings-sub').textContent = (savedLow < 0 && savedHigh > 0 ? 'about break-even · ' : '') + 'on ' + both + ' comparable requests';
  } else {
    $('savings').textContent = 'N/A';
    $('savings-sub').textContent = 'needs prices and a task baseline';
  }
}

function tableRows(events) {
  return events;
}
function table(events, tasks) {
  const rows = tableRows(events);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  if (page >= pages) page = pages - 1;
  const body = $('timeline');
  body.replaceChildren();
  for (const e of rows.slice(page * PAGE, (page + 1) * PAGE)) {
    const tr = document.createElement('tr');
    const cells = [
      new Date(e.timestamp).toLocaleString('en-US'),
      (e.requestedModel || 'N/A') + ' → ' + (e.observedModel || 'N/A'),
      e.requestedEffort || 'N/A',
      usdRange(actualCost(e)),
      (e.reasons || []).join(', ') || 'observation',
    ];
    for (const v of cells) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.append(td);
    }
    body.append(tr);
  }
  $('empty').hidden = rows.length > 0;
  $('page-info').textContent = rows.length ? 'Page ' + (page + 1) + ' of ' + pages + ' · ' + rows.length + ' rows' : '';
  $('prev').disabled = page === 0;
  $('next').disabled = page >= pages - 1;
  $('history-note').textContent = '';
}

function render() {
  if (!data) return;
  const events = filtered();
  const tasks = new Map(data.tasks.map(t => [t.id, t]));
  cards(events, tasks);
  chartSpend(events);
  chartModels(events);
  chartSavings(events);
  chartReasons(events);
  table(events, tasks);
  live(connected);
}

async function load() {
  data = await (await api('/v1/history')).json();
  options('project', [...new Set(data.events.map(e => e.project))]);
  render();
}

/* ---------- live updates ---------- */
let connected = false;
function live(ok) {
  connected = ok;
  const claude = data && (data.sessions.some(s => s.host === 'claude') || data.events.some(e => e.host === 'claude'));
  $('connection').className = ok ? 'ok' : '';
  $('connection').textContent = (ok ? '● Live' : '○ Reconnecting…') + (ok && claude ? ' · Claude Code' : '');
}
let timer;
function refreshSoon() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    load().then(() => live(true)).catch(() => live(false));
  }, 300);
}
function connect() {
  const source = new EventSource('/v1/stream');
  source.onopen = () => { live(true); refreshSoon(); };
  source.addEventListener('change', refreshSoon);
  source.onerror = () => live(false);
}

/* ---------- wiring ---------- */
$('login').hidden = true;
$('content').hidden = false;
load().then(() => { connect(); }).catch(e => {
  $('content').hidden = true;
  $('login').hidden = false;
  $('error').textContent = e.message;
});
setInterval(() => { if (data) refreshSoon(); }, 30000);
for (const id of ['project', 'app', 'period']) $(id).onchange = () => { page = 0; render(); };
$('prev').onclick = () => { page = Math.max(0, page - 1); render(); };
$('next').onclick = () => { page++; render(); };
window.addEventListener('resize', () => { if (data) render(); });
for (const format of ['json', 'csv']) {
  $(format).onclick = async () => {
    const blob = await (await api('/v1/export?format=' + format)).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'autoroute.' + format;
    a.click();
    URL.revokeObjectURL(url);
  };
}
$('purge').onclick = () => $('purge-dialog').showModal();
$('purge-cancel').onclick = () => $('purge-dialog').close();
$('purge-final').onclick = async () => {
  await api('/v1/purge', { confirm: 'PURGE' });
  $('purge-dialog').close();
  await load();
};

function setTheme(name) {
  document.documentElement.dataset.theme = name;
  $('theme-light').setAttribute('aria-pressed', String(name === 'light'));
  $('theme-dark').setAttribute('aria-pressed', String(name === 'dark'));
  try { localStorage.setItem('autoroute-theme', name); } catch (e) { name = name; }
}
let savedTheme = null;
try { savedTheme = localStorage.getItem('autoroute-theme'); } catch (e) { savedTheme = null; }
setTheme(savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('theme-light').onclick = () => setTheme('light');
$('theme-dark').onclick = () => setTheme('dark');
