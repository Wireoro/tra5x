// Small DOM + formatting helpers shared by all views. Text is always inserted via textContent
// (player and alliance names come from a third-party file and must be treated as untrusted).

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div', {class:'x', onclick: fn, 'aria-label': 'y'}, 'text', childNode, [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  append(el, children);
  return el;
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

// ---------- formatting ----------
const nf = new Intl.NumberFormat('en-US');
const nfCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const dShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dFull = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmt = {
  int: (n) => (n === null || n === undefined ? '-' : nf.format(n)),
  compact: (n) => (n === null || n === undefined ? '-' : nfCompact.format(n)),
  dec: (n) => (n === null || n === undefined ? '-' : nf1.format(n)),
  pct: (r, digits = 1) => (r === null || r === undefined ? '-' : `${(r * 100).toFixed(digits)}%`),
  date: (t) => dShort.format(new Date(t)),
  dateTime: (t) => dFull.format(new Date(t)),
  signed: (n) => (n === null || n === undefined ? '-' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${nf.format(Math.abs(n))}`),
  ago(t) {
    const ms = Date.now() - new Date(t).getTime();
    const m = Math.round(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 48) return `${hrs} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  },
};

// ---------- tribes: fixed slot per entity, so filters never repaint survivors ----------
export const TRIBES = {
  1: { name: 'Romans', slot: 1 },
  2: { name: 'Teutons', slot: 2 },
  3: { name: 'Gauls', slot: 3 },
  6: { name: 'Egyptians', slot: 4 },
  7: { name: 'Huns', slot: 5 },
  8: { name: 'Spartans', slot: 6 },
  9: { name: 'Vikings', slot: 7 },
  5: { name: 'Natars', slot: null },
  4: { name: 'Nature', slot: null },
};
export const PLAYER_TRIBES = [1, 2, 3, 6, 7, 8, 9];
export const tribeName = (id) => (TRIBES[id] ? TRIBES[id].name : `Tribe ${id}`);

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
/** Resolved colour for a tribe (Natars / unknown use the muted ink, never a series hue). */
export function tribeColor(id) {
  const t = TRIBES[id];
  return t && t.slot ? cssVar(`--s${t.slot}`) : cssVar('--muted');
}
export const seriesColor = (slot) => cssVar(`--s${slot}`);

// ---------- tooltip (single shared element) ----------
const tt = () => document.getElementById('tt');

/** rows: [{color?, value, name?}] ; head: string */
export function showTooltip(clientX, clientY, head, rows) {
  const el = tt();
  clear(el);
  if (head) el.append(h('div', { class: 'th' }, head));
  for (const r of rows) {
    el.append(
      h(
        'div',
        { class: 'row' },
        r.color ? h('span', { class: 'k', style: null }) : null,
        h('span', { class: 'v' }, r.value),
        r.name ? h('span', { class: 'n' }, r.name) : null,
      ),
    );
    // colour keys are set via CSSOM (allowed under our CSP), not via a style attribute
    if (r.color) el.lastChild.firstChild.style.background = r.color;
  }
  el.hidden = false;
  const pad = 14;
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + w > window.innerWidth - 8) x = clientX - w - pad;
  if (y + hgt > window.innerHeight - 8) y = clientY - hgt - pad;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}
export function hideTooltip() {
  tt().hidden = true;
}

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
