// Interactive canvas map: density heat-map, tribe view and alliance highlight, with pan/zoom,
// hover details, player search and tribe filters. Reads the compact arrays built by src/aggregate.js.

import { h, clear, fmt, cssVar, tribeColor, tribeName, PLAYER_TRIBES, showTooltip, hideTooltip, seriesColor } from './util.js';
import { legend } from './charts.js';

const NATAR = 5;

export function mountMap(container, data, { player = '', tag = '' } = {}) {
  clear(container);
  const n = data.count;
  const b = data.bounds || { minX: -100, maxX: 100, minY: -100, maxY: 100 };
  const X = Int16Array.from(data.x);
  const Y = Int16Array.from(data.y);
  const T = Uint8Array.from(data.t);
  const P = Int32Array.from(data.p);
  const U = Int32Array.from(data.u);
  const A = Int32Array.from(data.a);
  const F = Uint8Array.from(data.f);
  const spanX = b.maxX - b.minX;
  const spanY = b.maxY - b.minY;

  // spatial index: tile -> village
  const index = new Map();
  const key = (x, y) => (x - b.minX) * (spanY + 1) + (y - b.minY);
  for (let i = 0; i < n; i++) index.set(key(X[i], Y[i]), i);

  const state = {
    mode: 'density',
    metric: 'villages',
    tribes: new Set([...PLAYER_TRIBES, NATAR]),
    alliances: [], // indexes into data.at (max 3)
    matches: [], // village indexes matching the player search
    view: { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: 1 },
    fv: 0, // filter version (invalidates the density cache)
  };
  let grid = null;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let fitScale = 1;
  let raf = 0;

  // ---------- controls ----------
  const modeBtns = {};
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Map mode' });
  for (const [id, label] of [['density', 'Density'], ['tribes', 'Tribes'], ['alliances', 'Alliances']]) {
    modeBtns[id] = h('button', { type: 'button', 'aria-pressed': String(id === state.mode), onclick: () => setMode(id) }, label);
    seg.append(modeBtns[id]);
  }
  const metricSel = h('select', { id: 'map-metric', onchange: (e) => { state.metric = e.target.value; state.fv++; schedule(); } },
    h('option', { value: 'villages' }, 'Villages'), h('option', { value: 'pop' }, 'Population'));
  const allianceIn = h('input', { type: 'text', id: 'map-alliance', placeholder: 'up to 3 tags: ABC, XYZ', value: tag, 'aria-label': 'Alliance tags to highlight', autocomplete: 'off', oninput: () => { parseAlliances(); schedule(); } });
  const playerIn = h('input', { type: 'search', id: 'map-player', placeholder: 'find a player', value: player, 'aria-label': 'Find a player', autocomplete: 'off', onkeydown: (e) => { if (e.key === 'Enter') { parsePlayer(); centreOnMatches(); } }, oninput: () => { parsePlayer(); schedule(); } });
  const playerInfo = h('span', { class: 'muted', 'aria-live': 'polite' });
  const metricLabel = h('label', null, 'Density of', metricSel);
  const allianceLabel = h('label', null, 'Highlight alliances', allianceIn);
  const bar = h('div', { class: 'mapbar' },
    h('label', null, 'View', seg),
    metricLabel,
    allianceLabel,
    h('label', null, 'Player search', h('span', null, playerIn)),
    playerInfo,
    h('button', { class: 'btn', type: 'button', onclick: () => fit() }, 'Reset view'));
  const legendHost = h('div', { style: null });
  const canvas = h('canvas', { tabindex: 0, role: 'img', 'aria-label': `Map of ${fmt.int(n)} occupied villages. Use the arrow keys to pan and plus or minus to zoom. A table summary of map quadrants is on the Overview page.` });
  const info = h('div', { class: 'mapinfo' });
  const zoom = h('div', { class: 'mapzoom' },
    h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAt(1.4, W / 2, H / 2) }, '+'),
    h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAt(1 / 1.4, W / 2, H / 2) }, '−'));
  const wrap = h('div', { class: 'mapwrap' }, canvas, zoom, info);
  container.append(bar, legendHost, wrap);
  const ctx = canvas.getContext('2d');

  // ---------- state helpers ----------
  function setMode(m) {
    state.mode = m;
    for (const [id, btn] of Object.entries(modeBtns)) btn.setAttribute('aria-pressed', String(id === m));
    metricLabel.hidden = m !== 'density';
    allianceLabel.hidden = m !== 'alliances';
    renderLegend();
    schedule();
  }

  function parseAlliances() {
    const wanted = allianceIn.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).slice(0, 3);
    state.alliances = wanted.map((w) => data.at.findIndex((t) => t.toLowerCase() === w)).filter((i) => i >= 0);
    renderLegend();
  }

  function parsePlayer() {
    const q = playerIn.value.trim().toLowerCase();
    state.matches = [];
    if (q.length >= 2) {
      const ok = new Set();
      data.pn.forEach((name, i) => { if (name.toLowerCase().includes(q)) ok.add(i); });
      for (let i = 0; i < n; i++) if (ok.has(U[i])) state.matches.push(i);
    }
    playerInfo.textContent = q.length >= 2 ? `${fmt.int(state.matches.length)} village${state.matches.length === 1 ? '' : 's'} found` : '';
  }

  function centreOnMatches() {
    if (!state.matches.length) return;
    let sx = 0;
    let sy = 0;
    for (const i of state.matches) { sx += X[i]; sy += Y[i]; }
    state.view.cx = sx / state.matches.length;
    state.view.cy = sy / state.matches.length;
    state.view.scale = Math.min(Math.max(state.view.scale, fitScale * 3), 40);
    schedule();
  }

  function renderLegend() {
    clear(legendHost);
    if (state.mode === 'density') {
      const ramp = h('span', { class: 'bar' });
      for (let i = 0; i < 7; i++) { const sp = h('span'); sp.style.background = cssVar(`--h${i}`); ramp.append(sp); }
      legendHost.append(h('div', { class: 'ramp' }, 'fewer', ramp, 'more', h('span', { class: 'muted', id: 'cellinfo' }), h('span', { class: 'muted' }, ' Player villages only (Natars excluded).')));
    } else if (state.mode === 'tribes') {
      const counts = new Map();
      for (let i = 0; i < n; i++) counts.set(T[i], (counts.get(T[i]) || 0) + 1);
      const items = [...PLAYER_TRIBES, NATAR].filter((id) => counts.has(id)).map((id) => ({
        label: `${tribeName(id)} (${fmt.int(counts.get(id))})`,
        color: tribeColor(id),
        shape: 'box',
        pressed: state.tribes.has(id),
        onToggle: () => { if (state.tribes.has(id)) state.tribes.delete(id); else state.tribes.add(id); state.fv++; renderLegend(); schedule(); },
      }));
      legendHost.append(legend(items), h('p', { class: 'mapnote' }, 'Click a tribe to show or hide it. Seven hues on one map are hard to tell apart; hide tribes to compare pairs, or use the hover details.'));
    } else {
      const items = state.alliances.map((ai, i) => ({ label: data.at[ai], color: seriesColor(i + 1), shape: 'box' }));
      items.push({ label: 'Everyone else', color: cssVar('--muted'), shape: 'box' });
      legendHost.append(legend(items));
      if (!state.alliances.length) legendHost.append(h('p', { class: 'mapnote' }, 'Type up to three alliance tags above to highlight their villages.'));
    }
  }

  // ---------- geometry ----------
  const sx = (x) => W / 2 + (x - state.view.cx) * state.view.scale;
  const sy = (y) => H / 2 - (y - state.view.cy) * state.view.scale;

  function fit() {
    fitScale = Math.max(0.2, Math.min(W / (spanX + 6), H / (spanY + 6)));
    state.view = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: fitScale };
    schedule();
  }

  function zoomAt(factor, px, py) {
    const v = state.view;
    const next = Math.min(48, Math.max(fitScale * 0.7, v.scale * factor));
    const tx = v.cx + (px - W / 2) / v.scale;
    const ty = v.cy - (py - H / 2) / v.scale;
    v.scale = next;
    v.cx = tx - (px - W / 2) / next;
    v.cy = ty + (py - H / 2) / next;
    schedule();
  }

  // ---------- drawing ----------
  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function densityGrid(cs) {
    const k = `${cs}|${state.metric}|${state.fv}`;
    if (grid && grid.key === k) return grid;
    const cols = Math.ceil((spanX + 1) / cs);
    const rows = Math.ceil((spanY + 1) / cs);
    const arr = new Float32Array(cols * rows);
    for (let i = 0; i < n; i++) {
      if (T[i] === NATAR || !state.tribes.has(T[i])) continue;
      const gx = Math.floor((X[i] - b.minX) / cs);
      const gy = Math.floor((Y[i] - b.minY) / cs);
      arr[gy * cols + gx] += state.metric === 'pop' ? P[i] : 1;
    }
    let max = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
    grid = { key: k, cols, rows, arr, max, cs };
    return grid;
  }

  function drawGrid() {
    const v = state.view;
    const step = [10, 25, 50, 100, 200].find((st) => st * v.scale >= 64) || 200;
    ctx.lineWidth = 1;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = cssVar('--muted');
    const x0 = v.cx - W / 2 / v.scale;
    const x1 = v.cx + W / 2 / v.scale;
    const y0 = v.cy - H / 2 / v.scale;
    const y1 = v.cy + H / 2 / v.scale;
    ctx.strokeStyle = cssVar('--grid');
    for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
      const px = Math.round(sx(gx)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
      ctx.fillText(String(gx), px + 3, H - 5);
    }
    for (let gy = Math.ceil(y0 / step) * step; gy <= y1; gy += step) {
      const py = Math.round(sy(gy)) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
      ctx.fillText(String(gy), 4, py - 3);
    }
    ctx.strokeStyle = cssVar('--axis');
    ctx.strokeRect(sx(b.minX - 0.5), sy(b.maxY + 0.5), (spanX + 1) * v.scale, (spanY + 1) * v.scale);
    const zx = Math.round(sx(0)) + 0.5;
    const zy = Math.round(sy(0)) + 0.5;
    ctx.beginPath(); ctx.moveTo(zx, 0); ctx.lineTo(zx, H); ctx.moveTo(0, zy); ctx.lineTo(W, zy); ctx.stroke();
  }

  function draw() {
    raf = 0;
    if (!W || !H) return;
    const v = state.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cssVar('--surface');
    ctx.fillRect(0, 0, W, H);
    drawGrid();

    const pad = 2;
    const x0 = v.cx - W / 2 / v.scale - pad;
    const x1 = v.cx + W / 2 / v.scale + pad;
    const y0 = v.cy - H / 2 / v.scale - pad;
    const y1 = v.cy + H / 2 / v.scale + pad;
    const sz = Math.max(1.6, v.scale * (v.scale > 5 ? 0.86 : 1));
    let infoText = `${v.scale.toFixed(v.scale < 10 ? 1 : 0)} px per tile`;

    if (state.mode === 'density') {
      const cs = Math.max(1, Math.ceil(9 / v.scale));
      const g = densityGrid(cs);
      const colors = Array.from({ length: 7 }, (_, i) => cssVar(`--h${i}`));
      const size = cs * v.scale;
      for (let gy = 0; gy < g.rows; gy++) {
        for (let gx = 0; gx < g.cols; gx++) {
          const val = g.arr[gy * g.cols + gx];
          if (!val) continue;
          const tx = b.minX + gx * cs - 0.5;
          const ty = b.minY + gy * cs - 0.5;
          if (tx > x1 || tx + cs < x0 || ty > y1 || ty + cs < y0) continue;
          ctx.fillStyle = colors[Math.min(6, Math.floor(Math.sqrt(val / g.max) * 7))];
          ctx.fillRect(sx(tx), sy(ty + cs), size + 0.5, size + 0.5);
        }
      }
      const ci = document.getElementById('cellinfo');
      if (ci) ci.textContent = ` Each cell = ${cs}×${cs} tile${cs > 1 ? 's' : ''}, colour ~ square root of ${state.metric === 'pop' ? 'population' : 'villages'}.`;
    } else if (state.mode === 'tribes') {
      const colors = new Map([...PLAYER_TRIBES, NATAR].map((id) => [id, tribeColor(id)]));
      for (let i = 0; i < n; i++) {
        const x = X[i];
        const y = Y[i];
        if (x < x0 || x > x1 || y < y0 || y > y1 || !state.tribes.has(T[i])) continue;
        ctx.fillStyle = colors.get(T[i]) || cssVar('--muted');
        ctx.fillRect(sx(x) - sz / 2, sy(y) - sz / 2, sz, sz);
      }
    } else {
      const hi = new Map(state.alliances.map((ai, i) => [ai, seriesColor(i + 1)]));
      const dim = cssVar('--axis');
      ctx.fillStyle = dim;
      for (let i = 0; i < n; i++) {
        const x = X[i];
        const y = Y[i];
        if (x < x0 || x > x1 || y < y0 || y > y1 || hi.has(A[i])) continue;
        ctx.fillRect(sx(x) - sz / 2, sy(y) - sz / 2, sz, sz);
      }
      const big = Math.max(sz, 3);
      for (let i = 0; i < n; i++) {
        const c = hi.get(A[i]);
        if (!c) continue;
        const x = X[i];
        const y = Y[i];
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        ctx.fillStyle = c;
        ctx.fillRect(sx(x) - big / 2, sy(y) - big / 2, big, big);
      }
    }

    // searched player: rings in the ink colour
    if (state.matches.length && state.matches.length <= 300) {
      ctx.strokeStyle = cssVar('--ink');
      ctx.lineWidth = 2;
      const r = Math.max(6, sz + 5);
      for (const i of state.matches) {
        ctx.beginPath();
        ctx.arc(sx(X[i]), sy(Y[i]), r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    info.textContent = infoText;
  }

  // ---------- interaction ----------
  const pointers = new Map();
  let dragged = false;
  let pinch = 0;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    dragged = false;
    canvas.classList.add('dragging');
    hideTooltip();
    if (pointers.size === 2) pinch = pointerDistance();
  });

  const pointerDistance = () => {
    const [a, c] = [...pointers.values()];
    return Math.hypot(a.x - c.x, a.y - c.y);
  };

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return hover(e);
    const cur = { x: e.offsetX, y: e.offsetY };
    if (pointers.size === 1) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) dragged = true;
      state.view.cx -= dx / state.view.scale;
      state.view.cy += dy / state.view.scale;
      schedule();
    }
    pointers.set(e.pointerId, cur);
    if (pointers.size === 2) {
      const d = pointerDistance();
      if (pinch) {
        const [a, c] = [...pointers.values()];
        zoomAt(d / pinch, (a.x + c.x) / 2, (a.y + c.y) / 2);
      }
      pinch = d;
    }
    return undefined;
  });

  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    pinch = 0;
    if (!pointers.size) canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!pointers.size) hideTooltip(); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.offsetX, e.offsetY);
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 40 / state.view.scale;
    const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (map[e.key]) {
      e.preventDefault();
      state.view.cx += map[e.key][0];
      state.view.cy += map[e.key][1];
      schedule();
    } else if (e.key === '+' || e.key === '=') zoomAt(1.3, W / 2, H / 2);
    else if (e.key === '-') zoomAt(1 / 1.3, W / 2, H / 2);
    else if (e.key === '0') fit();
  });

  function hover(e) {
    if (dragged && e.buttons) return;
    const v = state.view;
    const tx = v.cx + (e.offsetX - W / 2) / v.scale;
    const ty = v.cy - (e.offsetY - H / 2) / v.scale;
    const r = Math.min(6, Math.ceil(7 / v.scale));
    let best = -1;
    let bd = Infinity;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const x = Math.round(tx) + dx;
        const y = Math.round(ty) + dy;
        if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
        const i = index.get(key(x, y));
        if (i === undefined || !state.tribes.has(T[i])) continue;
        const d = (x - tx) ** 2 + (y - ty) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best < 0 || Math.sqrt(bd) * v.scale > 9) return hideTooltip();
    const i = best;
    const flags = [F[i] & 1 ? 'capital' : '', F[i] & 2 ? 'city' : '', F[i] & 4 ? 'harbor' : ''].filter(Boolean).join(', ');
    showTooltip(e.clientX, e.clientY, data.n[i] || 'Village', [
      { color: tribeColor(T[i]), value: data.pn[U[i]], name: tribeName(T[i]) },
      { value: A[i] >= 0 ? `[${data.at[A[i]]}]` : 'No alliance', name: '' },
      { value: fmt.int(P[i]), name: `population${flags ? ` (${flags})` : ''}` },
      { value: `(${X[i]}|${Y[i]})`, name: `${Math.hypot(X[i], Y[i]).toFixed(1)} tiles from centre` },
    ]);
    return undefined;
  }

  // ---------- sizing ----------
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.floor(r.width);
    const hh = Math.floor(r.height);
    if (!w || !hh) return;
    const first = !W;
    W = w;
    H = hh;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    if (first) fit();
    else {
      fitScale = Math.max(0.2, Math.min(W / (spanX + 6), H / (spanY + 6)));
      schedule();
    }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  setMode('density');
  parseAlliances();
  parsePlayer();
  if (tag) setMode('alliances');
  requestAnimationFrame(() => {
    resize();
    if (state.matches.length) centreOnMatches();
  });

  return {
    dispose() {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      hideTooltip();
    },
  };
}
