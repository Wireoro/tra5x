// Dependency-free SVG charts (line + bar) following the data-viz spec used across Tra5x:
// thin marks, 2px lines, 4px rounded data-ends anchored to the baseline, recessive grid,
// crosshair + shared tooltip on lines, per-mark tooltip on bars, legend for >= 2 series,
// a table view under every chart, and colours resolved from CSS tokens (light/dark aware).

import { h, s, clear, fmt, cssVar, showTooltip, hideTooltip } from './util.js';

const observers = new Set();
export function disposeCharts() {
  for (const o of observers) o.disconnect();
  observers.clear();
  hideTooltip();
}

/** Calls draw(width) now and whenever the container's width changes. */
function mount(el, draw) {
  let last = 0;
  const run = () => {
    const w = Math.floor(el.clientWidth);
    if (!w || w === last) return;
    last = w;
    draw(w);
  };
  run();
  const ro = new ResizeObserver(run);
  ro.observe(el);
  observers.add(ro);
  requestAnimationFrame(run);
}

const nfTick = new Intl.NumberFormat('en-US');
const nfTickCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const tick = (n) => (Math.abs(n) >= 100000 ? nfTickCompact.format(n) : nfTick.format(n));

function niceScale(min, max, count = 4) {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo, hi, ticks };
}

const dateLong = (t) => new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function legend(items) {
  return h(
    'div',
    { class: 'legend' },
    items.map((it) => {
      const sw = h('span', { class: `swatch${it.shape === 'box' ? ' box' : ''}` });
      sw.style.background = it.color;
      const key = it.onToggle
        ? h('button', { class: 'key', type: 'button', 'aria-pressed': String(it.pressed !== false), onclick: it.onToggle }, sw, it.label)
        : h('span', { class: 'key' }, sw, it.label);
      return key;
    }),
  );
}

/** Collapsible table with the same numbers as the chart (also the accessible alternative). */
export function tableView(headers, rows, { label = 'Table view' } = {}) {
  return h(
    'details',
    { class: 'tv' },
    h('summary', null, label),
    h(
      'div',
      { class: 'tablewrap' },
      h(
        'table',
        null,
        h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: i ? 'r' : '' }, x)))),
        h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'r num' : '' }, c))))),
      ),
    ),
  );
}

function empty(el, msg) {
  clear(el).append(h('p', { class: 'empty' }, msg));
}

// =====================================================================================
// Line chart
// series: [{ label, color, points: [{t (ms), v}] }]
// =====================================================================================
export function lineChart(el, opt) {
  const { series, height = 240, format = fmt.int, zeroBase = false, ariaLabel = 'Line chart', table = true } = opt;
  clear(el);
  el.classList.add('chart');
  const active = series.filter((sr) => sr.points.length);
  if (!active.length) return empty(el, 'No data yet.');

  if (active.length >= 2) el.append(legend(active.map((sr) => ({ label: sr.label, color: sr.color }))));
  const host = h('div');
  el.append(host);
  if (table) {
    const times = [...new Set(active.flatMap((sr) => sr.points.map((p) => p.t)))].sort((a, b) => b - a);
    const maps = active.map((sr) => new Map(sr.points.map((p) => [p.t, p.v])));
    el.append(
      tableView(
        ['Date', ...active.map((sr) => sr.label)],
        times.map((t) => [fmt.date(t), ...maps.map((m) => (m.has(t) ? format(m.get(t)) : '-'))]),
      ),
    );
  }

  const times = [...new Set(active.flatMap((sr) => sr.points.map((p) => p.t)))].sort((a, b) => a - b);
  const byT = active.map((sr) => new Map(sr.points.map((p) => [p.t, p.v])));

  mount(host, (w) => {
    clear(host);
    const axis = cssVar('--axis');
    const grid = cssVar('--grid');
    const surface = cssVar('--surface');
    const ink = cssVar('--ink');

    const all = active.flatMap((sr) => sr.points.map((p) => p.v));
    let lo = zeroBase ? 0 : Math.min(...all);
    let hi = Math.max(...all);
    if (!zeroBase && hi > lo) {
      const pad = (hi - lo) * 0.08;
      lo -= pad;
      hi += pad;
    }
    const scale = niceScale(lo, hi, 4);
    const direct = active.length <= 4 && active.length >= 2 && w >= 480;
    const labelW = Math.max(...scale.ticks.map((v) => tick(v).length)) * 6.6 + 12;
    const m = { t: 10, r: direct ? 76 : 14, b: 26, l: Math.round(labelW) };
    const pw = w - m.l - m.r;
    const ph = height - m.t - m.b;
    const t0 = times[0];
    const t1 = times[times.length - 1];
    const x = (t) => (t1 === t0 ? m.l + pw / 2 : m.l + ((t - t0) / (t1 - t0)) * pw);
    const y = (v) => m.t + ph - ((v - scale.lo) / (scale.hi - scale.lo)) * ph;

    const svg = s('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, role: 'img', 'aria-label': ariaLabel, tabindex: 0 });

    for (const v of scale.ticks) {
      const yy = y(v);
      svg.append(s('line', { x1: m.l, x2: w - m.r, y1: yy, y2: yy, stroke: v === scale.lo ? axis : grid, 'stroke-width': 1 }));
      svg.append(s('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, tick(v)));
    }
    const nx = Math.max(2, Math.min(6, Math.floor(pw / 80)));
    const picks = times.length <= nx ? times.map((_, i) => i) : Array.from({ length: nx }, (_, i) => Math.round((i * (times.length - 1)) / (nx - 1)));
    for (const i of new Set(picks)) {
      const anchor = i === 0 && times.length > 1 ? 'start' : i === times.length - 1 && times.length > 1 ? 'end' : 'middle';
      svg.append(s('text', { x: x(times[i]), y: height - 6, 'text-anchor': anchor }, fmt.date(times[i])));
    }

    const ends = [];
    active.forEach((sr) => {
      if (sr.points.length === 1) {
        svg.append(s('circle', { cx: x(sr.points[0].t), cy: y(sr.points[0].v), r: 4, fill: sr.color }));
      } else {
        const d = sr.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
        svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      }
      const last = sr.points[sr.points.length - 1];
      ends.push({ label: sr.label, x: x(last.t), y: y(last.v) });
    });

    if (direct) {
      ends.sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
      for (const e of ends) svg.append(s('text', { class: 'lbl', x: e.x + 8, y: e.y + 4 }, e.label.length > 11 ? `${e.label.slice(0, 10)}...` : e.label));
    }

    // hover layer
    const cross = s('line', { y1: m.t, y2: m.t + ph, stroke: ink, 'stroke-width': 1, 'stroke-opacity': 0.35, visibility: 'hidden' });
    const dots = active.map((sr) => s('circle', { r: 4, fill: sr.color, stroke: surface, 'stroke-width': 2, visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const hit = s('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
    svg.append(hit);

    let current = -1;
    const show = (idx, cx, cy) => {
      idx = Math.max(0, Math.min(times.length - 1, idx));
      current = idx;
      const t = times[idx];
      cross.setAttribute('x1', x(t));
      cross.setAttribute('x2', x(t));
      cross.setAttribute('visibility', 'visible');
      const rows = [];
      active.forEach((sr, i) => {
        const v = byT[i].get(t);
        if (v === undefined) {
          dots[i].setAttribute('visibility', 'hidden');
          return;
        }
        dots[i].setAttribute('cx', x(t));
        dots[i].setAttribute('cy', y(v));
        dots[i].setAttribute('visibility', 'visible');
        rows.push({ color: sr.color, value: format(v), name: sr.label });
      });
      showTooltip(cx, cy, dateLong(t), rows);
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      hideTooltip();
      current = -1;
    };
    const nearest = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * w;
      let best = 0;
      let bd = Infinity;
      times.forEach((t, i) => {
        const d = Math.abs(x(t) - px);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      return best;
    };
    hit.addEventListener('pointermove', (e) => show(nearest(e.clientX), e.clientX, e.clientY));
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
      e.preventDefault();
      if (e.key === 'Escape') return hide();
      const r = svg.getBoundingClientRect();
      const next = current < 0 ? times.length - 1 : current + (e.key === 'ArrowRight' ? 1 : -1);
      const idx = Math.max(0, Math.min(times.length - 1, next));
      show(idx, r.left + (x(times[idx]) / w) * r.width, r.top + r.height / 2);
      return undefined;
    });

    host.append(svg);
  });
  return undefined;
}

// =====================================================================================
// Bar chart
// items: [{ label, value, color?, tip?: [{name, value}] }]
// =====================================================================================
function roundedBar(x, y, w, hgt, r, dir) {
  r = Math.max(0, Math.min(r, w / 2, hgt / 2));
  if (dir === 'right') {
    return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${hgt - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
  }
  // 'up': anchored at the baseline (bottom), rounded top
  return `M${x},${y + hgt}v${-(hgt - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${hgt - r}z`;
}

export function barChart(el, opt) {
  const { items, horizontal = false, format = fmt.int, height = 220, ariaLabel = 'Bar chart', valueLabels = true, valueHeader = 'Value', table = true, defaultSlot = 1 } = opt;
  clear(el);
  el.classList.add('chart');
  if (!items.length) return empty(el, 'No data yet.');

  const host = h('div');
  el.append(host);
  if (table) el.append(tableView(['Category', valueHeader], items.map((it) => [it.label, format(it.value)])));

  mount(host, (w) => {
    clear(host);
    const axis = cssVar('--axis');
    const grid = cssVar('--grid');
    const ink = cssVar('--ink');
    const base = cssVar(`--s${defaultSlot}`);
    const max = Math.max(...items.map((i) => i.value), 0);

    const tipFor = (it) => [{ value: format(it.value), name: valueHeader.toLowerCase() }, ...(it.tip || [])];

    if (horizontal) {
      const rowH = 30;
      const barH = 16;
      const H = items.length * rowH + 8;
      const labelW = Math.min(130, Math.max(...items.map((i) => i.label.length)) * 6.8 + 14);
      const valueW = valueLabels ? Math.max(...items.map((i) => format(i.value).length)) * 7 + 12 : 8;
      const pw = Math.max(40, w - labelW - valueW);
      const svg = s('svg', { viewBox: `0 0 ${w} ${H}`, width: w, height: H, role: 'img', 'aria-label': ariaLabel });
      svg.append(s('line', { x1: labelW, x2: labelW, y1: 2, y2: H - 2, stroke: axis, 'stroke-width': 1 }));
      items.forEach((it, i) => {
        const top = 4 + i * rowH;
        const bw = max ? (it.value / max) * pw : 0;
        const color = it.color || base;
        svg.append(s('text', { class: 'lbl', x: labelW - 8, y: top + rowH / 2 + 4, 'text-anchor': 'end' }, it.label));
        const bar = s('path', { d: bw > 0 ? roundedBar(labelW, top + (rowH - barH) / 2, Math.max(bw, 2), barH, 4, 'right') : '', fill: color });
        svg.append(bar);
        if (valueLabels) svg.append(s('text', { class: 'lbl', x: labelW + Math.max(bw, 2) + 6, y: top + rowH / 2 + 4 }, format(it.value)));
        const hit = s('rect', { x: 0, y: top, width: w, height: rowH, fill: 'transparent' });
        hit.addEventListener('pointermove', (e) => {
          bar.setAttribute('stroke', ink);
          bar.setAttribute('stroke-width', 1.5);
          showTooltip(e.clientX, e.clientY, it.label, tipFor(it));
        });
        hit.addEventListener('pointerleave', () => {
          bar.removeAttribute('stroke');
          hideTooltip();
        });
        svg.append(hit);
      });
      host.append(svg);
      return;
    }

    // vertical
    const scale = niceScale(0, max || 1, 4);
    const labelW = Math.max(...scale.ticks.map((v) => tick(v).length)) * 6.6 + 12;
    const m = { t: 10, r: 8, b: 30, l: Math.round(labelW) };
    const pw = w - m.l - m.r;
    const ph = height - m.t - m.b;
    const step = pw / items.length;
    const bw = Math.min(38, step * 0.62);
    const y = (v) => m.t + ph - (v / scale.hi) * ph;
    const svg = s('svg', { viewBox: `0 0 ${w} ${height}`, width: w, height, role: 'img', 'aria-label': ariaLabel });
    for (const v of scale.ticks) {
      const yy = y(v);
      svg.append(s('line', { x1: m.l, x2: w - m.r, y1: yy, y2: yy, stroke: v === 0 ? axis : grid, 'stroke-width': 1 }));
      svg.append(s('text', { x: m.l - 8, y: yy + 4, 'text-anchor': 'end' }, tick(v)));
    }
    const labelPx = Math.max(...items.map((it) => it.label.length)) * 6.4 + 10;
    const skip = Math.max(1, Math.ceil(labelPx / step));
    items.forEach((it, i) => {
      const cx = m.l + step * i + step / 2;
      const bh = (it.value / scale.hi) * ph;
      const bar = s('path', { d: bh > 0 ? roundedBar(cx - bw / 2, y(it.value), bw, Math.max(bh, 2), 4, 'up') : '', fill: it.color || base });
      svg.append(bar);
      if (i % skip === 0) svg.append(s('text', { x: cx, y: height - 10, 'text-anchor': 'middle' }, it.label));
      const hit = s('rect', { x: cx - step / 2, y: m.t, width: step, height: ph + 6, fill: 'transparent' });
      hit.addEventListener('pointermove', (e) => {
        bar.setAttribute('stroke', ink);
        bar.setAttribute('stroke-width', 1.5);
        showTooltip(e.clientX, e.clientY, it.label, tipFor(it));
      });
      hit.addEventListener('pointerleave', () => {
        bar.removeAttribute('stroke');
        hideTooltip();
      });
      svg.append(hit);
    });
    host.append(svg);
  });
  return undefined;
}
