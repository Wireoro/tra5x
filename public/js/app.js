import { h, $, clear, fmt, PLAYER_TRIBES, tribeName, tribeColor, seriesColor, debounce, hideTooltip } from './util.js';
import { api } from './api.js';
import { lineChart, barChart, disposeCharts, tableView } from './charts.js';
import { mountMap } from './map.js';

const main = $('#view');
let token = 0;
let mapHandle = null;
let statusCache = null;
let pollTimer = 0;

// ------------------------------------------------------------------ small building blocks
const card = (title, sub, ...body) =>
  h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, title), sub ? h('span', { class: 'sub' }, sub) : null), ...body);

function deltaNode(v, { suffix = '' } = {}) {
  if (v === null || v === undefined) return h('span', { class: 'muted' }, '-');
  if (v === 0) return h('span', { class: 'muted' }, `0${suffix}`);
  return h('span', { class: v > 0 ? 'up' : 'down' }, `${v > 0 ? '▲' : '▼'} ${fmt.signed(v)}${suffix}`);
}

function tribeCell(id) {
  const dot = h('span', { class: 'dot' });
  dot.style.background = tribeColor(id);
  return h('span', null, dot, tribeName(id));
}

/**
 * columns: [{label, r?:bool, cell:(row)=>Node|string, sort?:string}]
 * sort: {key, dir}; onSort(key)
 */
function dataTable({ columns, rows, sort, onSort, empty = 'Nothing to show.' }) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  const head = columns.map((c) => {
    const active = sort && c.sort && sort.key === c.sort;
    const label = c.sort && onSort ? h('button', { type: 'button', onclick: () => onSort(c.sort), 'aria-label': `Sort by ${c.label}` }, c.label, active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '') : c.label;
    const th = h('th', { class: c.r ? 'r' : '', scope: 'col' }, label);
    if (active) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
    return th;
  });
  return h('div', { class: 'tablewrap' },
    h('table', null, h('thead', null, h('tr', null, head)),
      h('tbody', null, rows.map((row) => h('tr', null, columns.map((c) => h('td', { class: c.r ? 'r num' : '' }, c.cell(row))))))));
}

const nameButton = (text, onClick) => h('button', { class: 'rowbtn', type: 'button', onclick: onClick }, text);

function playerColumns({ withRank = true } = {}) {
  return [
    withRank ? { label: '#', r: true, sort: 'rank', cell: (p) => fmt.int(p.rank) } : null,
    { label: 'Player', sort: 'name', cell: (p) => nameButton(p.name, () => openPlayer(p.id)) },
    { label: 'Tribe', cell: (p) => tribeCell(p.tribe) },
    { label: 'Alliance', cell: (p) => (p.alliance_id ? nameButton(`[${p.alliance_tag || p.alliance_id}]`, () => openAlliance(p.alliance_id)) : h('span', { class: 'muted' }, '-')) },
    { label: 'Villages', r: true, sort: 'villages', cell: (p) => fmt.int(p.villages) },
    { label: 'Population', r: true, sort: 'population', cell: (p) => fmt.int(p.population) },
    { label: 'Change', r: true, sort: 'pop_delta', cell: (p) => deltaNode(p.pop_delta) },
  ].filter(Boolean);
}

function allianceColumns() {
  return [
    { label: '#', r: true, sort: 'rank', cell: (a) => fmt.int(a.rank) },
    { label: 'Alliance', sort: 'tag', cell: (a) => nameButton(`[${a.tag}]`, () => openAlliance(a.id)) },
    { label: 'Members', r: true, sort: 'members', cell: (a) => fmt.int(a.members) },
    { label: 'Villages', r: true, sort: 'villages', cell: (a) => fmt.int(a.villages) },
    { label: 'Population', r: true, sort: 'population', cell: (a) => fmt.int(a.population) },
    { label: 'Avg / member', r: true, cell: (a) => fmt.int(a.members ? Math.round(a.population / a.members) : 0) },
    { label: 'Change', r: true, sort: 'pop_delta', cell: (a) => deltaNode(a.pop_delta) },
  ];
}

function pager(state, total, onPage) {
  const from = total ? state.offset + 1 : 0;
  const to = Math.min(total, state.offset + state.limit);
  return h('div', { class: 'pager' },
    h('button', { class: 'btn', type: 'button', disabled: state.offset <= 0, onclick: () => onPage(Math.max(0, state.offset - state.limit)) }, 'Previous'),
    h('button', { class: 'btn', type: 'button', disabled: to >= total, onclick: () => onPage(state.offset + state.limit) }, 'Next'),
    h('span', { class: 'spacer' }),
    h('span', null, `${fmt.int(from)}–${fmt.int(to)} of ${fmt.int(total)}`));
}

function segmented(options, value, onChange, label) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const [id, text] of options) {
    wrap.append(h('button', { type: 'button', 'aria-pressed': String(id === value), onclick: () => onChange(id) }, text));
  }
  return wrap;
}

// ------------------------------------------------------------------ events (change log)
const EVENT_LABELS = {
  village_founded: 'Village founded',
  village_conquered: 'Village conquered',
  village_abandoned: 'Village lost',
  player_new: 'New player',
  player_departed: 'Player left',
  alliance_joined: 'Joined alliance',
  alliance_left: 'Left alliance',
  alliance_switched: 'Changed alliance',
  alliance_created: 'Alliance founded',
  alliance_disbanded: 'Alliance disbanded',
};
const EVENT_FILTERS = [['', 'All'], ['village', 'Villages'], ['alliance', 'Alliances'], ['player', 'Players']];

const playerLink = (id, name) => (id ? nameButton(name || `#${id}`, () => openPlayer(id)) : h('span', { class: 'muted' }, '-'));
const allianceLink = (id, tag) => (id ? nameButton(`[${tag || id}]`, () => openAlliance(id)) : h('span', { class: 'muted' }, 'no alliance'));
const tileText = (e) => (e.x === null || e.x === undefined ? '' : `(${e.x}|${e.y})`);

/** One readable sentence per event, with clickable players / alliances. */
function describeEvent(e) {
  const where = tileText(e);
  switch (e.kind) {
    case 'village_founded':
      return h('span', null, playerLink(e.player_id, e.player_name), ` founded ${e.village_name ? `"${e.village_name}" ` : 'a village '}at ${where}`);
    case 'village_conquered':
      return h('span', null, playerLink(e.player_id, e.player_name), ` took ${e.village_name ? `"${e.village_name}" ` : 'the village '}at ${where} from `, playerLink(e.from_player_id, e.from_player_name));
    case 'village_abandoned':
      // the former owner is very often gone from the map too, so this one is not a link
      return h('span', null, `${e.village_name ? `"${e.village_name}" ` : 'Village '}at ${where} of `, h('b', null, e.player_name || `#${e.player_id}`), ' is gone (destroyed or abandoned)');
    case 'player_new':
      return h('span', null, playerLink(e.player_id, e.player_name), ' appeared on the map', e.alliance_id ? [' (', allianceLink(e.alliance_id, e.alliance_tag), ')'] : '');
    case 'player_departed':
      return h('span', null, h('b', null, e.player_name || `#${e.player_id}`), ' is no longer on the map', e.alliance_id ? [' (was ', allianceLink(e.alliance_id, e.alliance_tag), ')'] : '');
    case 'alliance_joined':
      return h('span', null, playerLink(e.player_id, e.player_name), ' joined ', allianceLink(e.alliance_id, e.alliance_tag));
    case 'alliance_left':
      return h('span', null, playerLink(e.player_id, e.player_name), ' left ', allianceLink(e.from_alliance_id, e.from_alliance_tag));
    case 'alliance_switched':
      return h('span', null, playerLink(e.player_id, e.player_name), ' moved from ', allianceLink(e.from_alliance_id, e.from_alliance_tag), ' to ', allianceLink(e.alliance_id, e.alliance_tag));
    case 'alliance_created':
      return h('span', null, allianceLink(e.alliance_id, e.alliance_tag), ' appeared');
    case 'alliance_disbanded':
      return h('span', null, h('b', null, `[${e.alliance_tag || e.alliance_id}]`), ' disbanded');
    default:
      return h('span', null, e.kind);
  }
}

function eventColumns() {
  return [
    { label: 'Day', cell: (e) => (e.taken_at ? fmt.date(e.taken_at) : '-') },
    { label: 'Event', cell: (e) => EVENT_LABELS[e.kind] || e.kind },
    { label: 'What happened', cell: describeEvent },
    { label: 'Population', r: true, cell: (e) => fmt.int(e.population) },
  ];
}

// ------------------------------------------------------------------ modals
function openModal(title, buildBody) {
  const dlg = h('dialog', { 'aria-label': title });
  const closeBtn = h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Close');
  const body = h('div');
  dlg.append(h('div', { class: 'dhead' }, h('h2', null, title), closeBtn), body);
  dlg.addEventListener('close', () => {
    hideTooltip();
    dlg.remove();
  });
  dlg.addEventListener('click', (e) => {
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
  document.body.append(dlg);
  dlg.showModal();
  buildBody(body).catch((err) => {
    clear(body).append(h('p', { class: 'empty' }, err.status === 404 ? 'This one is no longer on the map (the account or alliance was deleted or dissolved).' : `Could not load details: ${err.message}`));
  });
}

async function openPlayer(id) {
  openModal('Player', async (body) => {
    body.append(h('p', { class: 'empty' }, 'Loading...'));
    const { player: p, history, events } = await api('players/' + id);
    clear(body);
    body.previousSibling.firstChild.textContent = p.name;
    const facts = h('div', { class: 'facts' },
      h('span', null, 'Rank ', h('b', null, `#${fmt.int(p.rank)}`)),
      h('span', null, 'Tribe ', h('b', null, tribeName(p.tribe))),
      h('span', null, 'Villages ', h('b', null, fmt.int(p.villages))),
      h('span', null, 'Population ', h('b', null, fmt.int(p.population))),
      h('span', null, '24h ', deltaNode(p.pop_delta)),
      p.capital_x !== null && p.capital_x !== undefined ? h('span', null, 'Capital ', h('b', null, `(${p.capital_x}|${p.capital_y})`)) : null);
    body.append(facts);
    if (p.alliance_id) {
      body.append(h('p', null, 'Alliance: ', nameButton(`[${p.alliance_tag || p.alliance_id}]`, () => {
        body.closest('dialog').close();
        openAlliance(p.alliance_id);
      })));
    }
    body.append(h('p', { style: null }, h('a', { href: `#/map?player=${encodeURIComponent(p.name)}`, onclick: () => body.closest('dialog').close() }, 'Show this player on the map')));
    const chart = h('div');
    body.append(h('h3', null, 'Population over time'), chart);
    if (history.length >= 2) {
      lineChart(chart, { series: [{ label: 'Population', color: seriesColor(1), points: history.map((r) => ({ t: Date.parse(r.taken_at), v: r.population })) }], height: 200, ariaLabel: `Population history of ${p.name}` });
    } else {
      chart.append(h('p', { class: 'muted' }, 'Every player is recorded once a day; the chart needs at least two daily snapshots.'));
    }
    if (events && events.length) body.append(h('h3', null, 'Recent activity'), dataTable({ columns: eventColumns(), rows: events }));
  });
}

async function openAlliance(id) {
  openModal('Alliance', async (body) => {
    body.append(h('p', { class: 'empty' }, 'Loading...'));
    const [{ alliance: a, history, events }, members] = await Promise.all([api('alliances/' + id), api('players', { alliance: id, sort: 'population', dir: 'desc', limit: 50 })]);
    clear(body);
    body.previousSibling.firstChild.textContent = `[${a.tag}]`;
    body.append(h('div', { class: 'facts' },
      h('span', null, 'Rank ', h('b', null, `#${fmt.int(a.rank)}`)),
      h('span', null, 'Members ', h('b', null, fmt.int(a.members))),
      h('span', null, 'Villages ', h('b', null, fmt.int(a.villages))),
      h('span', null, 'Population ', h('b', null, fmt.int(a.population))),
      h('span', null, 'Change ', deltaNode(a.pop_delta))));
    body.append(h('p', null, h('a', { href: `#/map?tag=${encodeURIComponent(a.tag)}`, onclick: () => body.closest('dialog').close() }, 'Highlight this alliance on the map')));
    const chart = h('div');
    body.append(h('h3', null, 'Population over time'), chart);
    if (history.length >= 2) lineChart(chart, { series: [{ label: 'Population', color: seriesColor(1), points: history.map((r) => ({ t: Date.parse(r.taken_at), v: r.population })) }], height: 200, ariaLabel: `Population history of ${a.tag}` });
    else chart.append(h('p', { class: 'muted' }, 'Needs at least two daily snapshots.'));
    body.append(h('h3', null, `Members (top ${Math.min(50, members.total)} by population)`),
      dataTable({ columns: playerColumns({ withRank: false }).filter((c) => c.label !== 'Alliance'), rows: members.rows }));
    if (events && events.length) body.append(h('h3', null, 'Recent activity'), dataTable({ columns: eventColumns(), rows: events }));
  });
}

// ------------------------------------------------------------------ status / chrome
async function loadStatus() {
  try {
    statusCache = await api('status', {}, { fresh: true });
  } catch {
    statusCache = null;
  }
  renderChrome();
  return statusCache;
}

function renderChrome() {
  const st = statusCache;
  const banner = $('#banner');
  const world = $('#world');
  const fresh = $('#freshness');
  if (!st) {
    banner.hidden = false;
    banner.textContent = 'Cannot reach the Tra5x server right now.';
    return;
  }
  world.textContent = st.world;
  const msgs = [];
  if (st.warning) msgs.push(st.warning);
  const latest = st.latest_snapshot;
  if (latest) {
    const age = Date.now() - Date.parse(latest.taken_at);
    fresh.textContent = `Snapshot ${fmt.dateTime(latest.taken_at)} (${fmt.ago(latest.taken_at)})`;
    if (age > 36 * 3600 * 1000) msgs.push('The data is more than 36 hours old; the daily refresh may be failing.');
  } else {
    fresh.textContent = 'No data yet';
    msgs.push(st.ingest.running ? 'The first download of map.sql is running...' : 'No snapshot has been stored yet; the first download of map.sql is pending.');
  }
  const last = st.ingest && st.ingest.lastResult;
  if (last && last.status === 'error') msgs.push(`The last refresh failed: ${last.message}`);
  const stg = st.storage;
  const stgNode = $('#storage');
  if (stg && stg.db_bytes !== null && stg.db_bytes !== undefined) {
    const mb = (b) => `${fmt.int(Math.round(b / 1048576))} MB`;
    stgNode.textContent = ` Database: ${mb(stg.db_bytes)} of ${mb(stg.limit_bytes)} (${fmt.pct(stg.used_ratio, 0)}), history of ${stg.player_history}${stg.retention_days ? `, kept ${stg.retention_days} days` : ''}${stg.est_days_left !== null && stg.est_days_left !== undefined ? `, room for about ${fmt.int(stg.est_days_left)} more days` : ''}.`;
    if (stg.used_ratio >= 0.8) msgs.push(`The database is ${fmt.pct(stg.used_ratio, 0)} full. Set HISTORY_RETENTION_DAYS or HISTORY_TOP_PLAYERS, or upgrade the Supabase plan.`);
  } else {
    stgNode.textContent = '';
  }
  banner.hidden = !msgs.length;
  banner.textContent = msgs.join(' ');
}

// ------------------------------------------------------------------ views
const bucketLabel = (b, compact) => {
  const f = compact ? fmt.compact : fmt.int;
  if (b.max === null) return `${f(b.min)}+`;
  if (b.max === b.min) return f(b.min);
  return `${f(b.min)}–${f(b.max)}`;
};

async function viewOverview(root, params, alive) {
  const ov = await api('overview');
  if (!alive()) return;
  if (ov.empty) return renderEmpty(root);

  const t = ov.totals;
  const d = ov.deltas;
  const prevDate = ov.previous ? fmt.date(ov.previous.taken_at) : null;
  const kpi = (label, value, delta, note) =>
    h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value num' }, value),
      h('div', { class: 'delta' }, delta === undefined ? '' : delta === null ? 'first snapshot' : [deltaNode(delta), prevDate ? ` since ${prevDate}` : ''], note || ''));

  const kpis = h('div', { class: 'kpis' },
    kpi('Players', fmt.int(t.players), d.players),
    kpi('Alliances', fmt.int(t.alliances), d.alliances),
    kpi('Villages', fmt.int(t.villages), d.villages),
    kpi('Population', fmt.int(t.population), d.population),
    kpi('Avg population / village', fmt.dec(ov.derived.avg_pop_per_village)),
    kpi('Avg villages / player', fmt.dec(ov.derived.avg_villages_per_player)),
    kpi('Players in an alliance', fmt.pct(ov.derived.alliance_membership, 0), undefined, ` avg size ${fmt.dec(ov.derived.avg_alliance_size)}`),
    kpi('Top 10 players hold', fmt.pct(ov.derived.top10_share), undefined, ` top 100: ${fmt.pct(ov.derived.top100_share)}`));

  const facts = h('p', { class: 'muted' },
    `New players ${fmt.int(d.new_players)} · departed ${fmt.int(d.departed_players)} · capitals ${fmt.int(t.capitals)} · cities ${fmt.int(t.cities)} · harbours ${fmt.int(t.harbors)} · Natar villages ${fmt.int(t.natar_villages)}`);

  // Tribes
  let metric = 'players';
  const tribeHost = h('div');
  const tribeSeg = h('div');
  const playerTribes = ov.tribes.filter((x) => x.tribe !== 5);
  const natar = ov.tribes.find((x) => x.tribe === 5);
  const drawTribes = () => {
    clear(tribeSeg).append(segmented([['players', 'Players'], ['villages', 'Villages'], ['population', 'Population']], metric, (m) => { metric = m; drawTribes(); }, 'Tribe metric'));
    const shareKey = { players: 'player_share', villages: 'village_share', population: 'population_share' }[metric];
    barChart(tribeHost, {
      horizontal: true,
      valueHeader: metric[0].toUpperCase() + metric.slice(1),
      ariaLabel: `${metric} by tribe`,
      items: playerTribes.map((x) => ({
        label: x.name,
        value: x[metric],
        color: tribeColor(x.tribe),
        tip: [{ value: fmt.pct(x[shareKey]), name: 'share' }, ...(metric === 'population' && x.population_delta !== null ? [{ value: fmt.signed(x.population_delta), name: 'since last snapshot' }] : [])],
      })),
    });
  };
  drawTribes();
  const tribeCard = card('Tribes', 'Natars are not counted here', tribeSeg, tribeHost,
    natar ? h('p', { class: 'muted' }, `Natars: ${fmt.int(natar.villages)} villages, ${fmt.int(natar.population)} population.`) : null);

  const popHist = h('div');
  barChart(popHist, { items: ov.distributions.pop_buckets.map((b) => ({ label: bucketLabel(b, true), value: b.count, tip: [{ value: `${fmt.int(b.min)}${b.max === null ? '+' : `–${fmt.int(b.max)}`}`, name: 'population band' }] })), valueHeader: 'Players', ariaLabel: 'Number of players by population band' });
  const vilHist = h('div');
  barChart(vilHist, { items: ov.distributions.village_buckets.map((b) => ({ label: bucketLabel(b, false), value: b.count })), valueHeader: 'Players', ariaLabel: 'Number of players by village count' });

  const quadNames = { NE: 'North-east', NW: 'North-west', SW: 'South-west', SE: 'South-east' };
  const quadHost = h('div');
  const q = ov.distributions.quadrants;
  if (q) barChart(quadHost, { horizontal: true, valueHeader: 'Villages', ariaLabel: 'Villages by map quadrant', items: Object.keys(quadNames).map((k) => ({ label: quadNames[k], value: q[k].villages, tip: [{ value: fmt.int(q[k].population), name: 'population' }] })) });

  const ringHost = h('div');
  const rings = ov.distributions.rings;
  if (rings) barChart(ringHost, { valueHeader: 'Villages', ariaLabel: 'Villages by distance from the map centre', items: rings.items.map((r) => ({ label: `${r.from}–${r.to}`, value: r.villages, tip: [{ value: fmt.int(r.population), name: 'population' }] })) });

  const regions = ov.distributions.regions || [];
  const regionHost = h('div');
  if (regions.length) barChart(regionHost, { horizontal: true, valueHeader: 'Villages', ariaLabel: 'Villages by region', items: regions.slice(0, 10).map((r) => ({ label: r.region, value: r.villages, tip: [{ value: fmt.int(r.population), name: 'population' }] })) });

  const moversTable = (rows, emptyText) => dataTable({
    columns: [
      { label: 'Player', cell: (p) => nameButton(p.name, () => openPlayer(p.id)) },
      { label: 'Alliance', cell: (p) => (p.alliance_tag ? `[${p.alliance_tag}]` : '-') },
      { label: 'Population', r: true, cell: (p) => fmt.int(p.population) },
      { label: 'Change', r: true, cell: (p) => deltaNode(p.pop_delta) },
    ],
    rows,
    empty: ov.previous ? emptyText : 'Available from the second daily snapshot.',
  });

  clear(root).append(h('div', { class: 'stack' },
    kpis, facts,
    h('div', { class: 'grid' }, tribeCard,
      card('Player size', 'players per population band (lower bound shown)', popHist),
      card('Villages per player', 'players by number of villages', vilHist)),
    h('div', { class: 'grid' },
      q ? card('Map quadrants', 'occupied villages', quadHost) : null,
      rings ? card('Distance from centre', `villages per ${rings.width}-tile ring`, ringHost) : null,
      regions.length ? card('Top regions', 'by villages', regionHost) : null),
    h('div', { class: 'grid wide' },
      card('Top 10 players', 'by population', dataTable({ columns: playerColumns(), rows: ov.top_players }), h('p', null, h('a', { href: '#/players' }, 'All players'))),
      card('Top 10 alliances', 'by population', dataTable({ columns: allianceColumns(), rows: ov.top_alliances }), h('p', null, h('a', { href: '#/alliances' }, 'All alliances')))),
    h('div', { class: 'grid wide' },
      card('Biggest gainers', 'population change since the previous snapshot', moversTable(ov.gainers, 'Nobody gained population in this period.')),
      card('Biggest losers', 'population change since the previous snapshot', moversTable(ov.losers, 'Nobody lost population in this period.')))));
}

async function viewPlayers(root, params, alive) {
  const st = { q: params.get('q') || '', tribe: params.get('tribe') || '', tag: params.get('tag') || '', sort: 'rank', dir: 'asc', offset: 0, limit: 50 };
  const results = h('div');
  const qIn = h('input', { type: 'search', id: 'pq', placeholder: 'name contains...', value: st.q, autocomplete: 'off', oninput: debounce((e) => { st.q = e.target.value.trim(); st.offset = 0; load(); }, 300) });
  const tribeSel = h('select', { id: 'pt', onchange: (e) => { st.tribe = e.target.value; st.offset = 0; load(); } },
    h('option', { value: '' }, 'All tribes'), PLAYER_TRIBES.map((id) => h('option', { value: id, selected: String(id) === st.tribe }, tribeName(id))));
  const tagIn = h('input', { type: 'search', id: 'pa', placeholder: 'alliance tag', value: st.tag, autocomplete: 'off', oninput: debounce((e) => { st.tag = e.target.value.trim(); st.offset = 0; load(); }, 300) });

  const onSort = (key) => {
    if (st.sort === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else { st.sort = key; st.dir = key === 'name' || key === 'rank' ? 'asc' : 'desc'; }
    st.offset = 0;
    load();
  };

  async function load() {
    results.classList.add('loading');
    try {
      const data = await api('players', { q: st.q, tribe: st.tribe, tag: st.tag, sort: st.sort, dir: st.dir, limit: st.limit, offset: st.offset });
      if (!alive()) return;
      clear(results).append(
        dataTable({ columns: playerColumns(), rows: data.rows, sort: { key: st.sort, dir: st.dir }, onSort, empty: 'No players match these filters.' }),
        pager(st, data.total, (o) => { st.offset = o; load(); }));
    } catch (err) {
      clear(results).append(h('p', { class: 'empty' }, `Could not load players: ${err.message}`));
    } finally {
      results.classList.remove('loading');
    }
  }

  clear(root).append(h('div', { class: 'stack' },
    h('div', { class: 'filters' }, h('label', null, 'Search', qIn), h('label', null, 'Tribe', tribeSel), h('label', null, 'Alliance tag (exact)', tagIn)),
    card('Players', 'click a column to sort, click a name for details', results)));
  await load();
}

async function viewAlliances(root, params, alive) {
  const st = { q: params.get('q') || '', sort: 'rank', dir: 'asc', offset: 0, limit: 50 };
  const results = h('div');
  const qIn = h('input', { type: 'search', id: 'aq', placeholder: 'tag contains...', value: st.q, autocomplete: 'off', oninput: debounce((e) => { st.q = e.target.value.trim(); st.offset = 0; load(); }, 300) });
  const onSort = (key) => {
    if (st.sort === key) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else { st.sort = key; st.dir = key === 'tag' || key === 'rank' ? 'asc' : 'desc'; }
    st.offset = 0;
    load();
  };
  async function load() {
    results.classList.add('loading');
    try {
      const data = await api('alliances', { q: st.q, sort: st.sort, dir: st.dir, limit: st.limit, offset: st.offset });
      if (!alive()) return;
      clear(results).append(
        dataTable({ columns: allianceColumns(), rows: data.rows, sort: { key: st.sort, dir: st.dir }, onSort, empty: 'No alliances match.' }),
        pager(st, data.total, (o) => { st.offset = o; load(); }));
    } catch (err) {
      clear(results).append(h('p', { class: 'empty' }, `Could not load alliances: ${err.message}`));
    } finally {
      results.classList.remove('loading');
    }
  }
  clear(root).append(h('div', { class: 'stack' }, h('div', { class: 'filters' }, h('label', null, 'Search', qIn)), card('Alliances', 'click a tag for members and history', results)));
  await load();
}

async function viewTrends(root, params, alive) {
  let days = Number(params.get('days')) || 0;
  const body = h('div', { class: 'stack' });
  const rangeHost = h('div', { class: 'filters' });
  clear(root).append(h('div', { class: 'stack' }, rangeHost, body));

  async function load() {
    clear(rangeHost).append(segmented([[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'All']], days, (d) => { days = d; load(); }, 'Time range'));
    body.classList.add('loading');
    let hist;
    try {
      hist = await api('history', { days });
    } catch (err) {
      clear(body).append(h('p', { class: 'empty' }, `Could not load history: ${err.message}`));
      body.classList.remove('loading');
      return;
    }
    if (!alive()) return;
    body.classList.remove('loading');
    disposeCharts();
    const snaps = hist.snapshots;
    if (snaps.length < 2) {
      clear(body).append(card('Trends', null,
        h('p', { class: 'empty' }, snaps.length === 1 ? 'One snapshot is stored so far. Trends appear after the next daily map.sql refresh (server midnight).' : 'No snapshots yet.')));
      return;
    }
    const pts = (key) => snaps.map((x) => ({ t: Date.parse(x.taken_at), v: x[key] }));
    const single = (title, key, sub) => {
      const host = h('div');
      lineChart(host, { series: [{ label: title, color: seriesColor(1), points: pts(key) }], height: 200, ariaLabel: `${title} over time` });
      return card(title, sub, host);
    };
    const churnHost = h('div');
    lineChart(churnHost, { series: [{ label: 'New', color: seriesColor(1), points: pts('new_players') }, { label: 'Departed', color: seriesColor(2), points: pts('departed_players') }], zeroBase: true, height: 200, ariaLabel: 'New and departed players per snapshot' });
    const tribeHost = h('div');
    lineChart(tribeHost, {
      series: hist.tribes.filter((tr) => tr.tribe !== 5).map((tr) => ({ label: tr.name, color: tribeColor(tr.tribe), points: tr.points.map((p) => ({ t: Date.parse(p.taken_at), v: p.population })) })),
      height: 260, ariaLabel: 'Population by tribe over time',
    });
    const concHost = h('div');
    const withShare = snaps.filter((x) => x.top10_share !== null && x.top10_share !== undefined);
    if (withShare.length >= 2) {
      lineChart(concHost, {
        series: [
          { label: 'Top 10', color: seriesColor(1), points: withShare.map((x) => ({ t: Date.parse(x.taken_at), v: Number(x.top10_share) * 100 })) },
          { label: 'Top 100', color: seriesColor(2), points: withShare.map((x) => ({ t: Date.parse(x.taken_at), v: Number(x.top100_share) * 100 })) },
        ],
        zeroBase: true, height: 200, format: (v) => `${v.toFixed(1)}%`, ariaLabel: 'Share of total population held by the top 10 and top 100 players',
      });
    } else {
      concHost.append(h('p', { class: 'muted' }, 'Recorded from now on; needs two daily snapshots.'));
    }
    const allyHost = h('div');
    lineChart(allyHost, {
      series: hist.alliances.map((a, i) => ({ label: `[${a.tag}]`, color: seriesColor(i + 1), points: a.points.map((p) => ({ t: Date.parse(p.taken_at), v: p.population })) })),
      height: 260, ariaLabel: 'Population of the top alliances over time',
    });
    clear(body).append(
      h('div', { class: 'grid' }, single('Population', 'population', 'all players'), single('Villages', 'villages', 'player villages'), single('Players', 'players', 'active accounts'), single('Alliances', 'alliances', 'with at least one member')),
      h('div', { class: 'grid wide' }, card('Player churn', 'new and departed accounts per snapshot', churnHost), card('Population by tribe', 'Natars excluded', tribeHost)),
      card('Top alliances', 'population of the current top 5', allyHost),
      card('Population concentration', 'share of the world population held by the largest players (%)', concHost));
  }
  await load();
}

async function viewActivity(root, params, alive) {
  const st = { kind: params.get('kind') || '', offset: 0, limit: 50 };
  const results = h('div');
  const filterHost = h('div', { class: 'filters' });

  async function load() {
    clear(filterHost).append(segmented(EVENT_FILTERS, st.kind, (k) => { st.kind = k; st.offset = 0; load(); }, 'Event type'));
    results.classList.add('loading');
    try {
      const data = await api('events', { kind: st.kind, limit: st.limit, offset: st.offset });
      if (!alive()) return;
      clear(results).append(
        dataTable({ columns: eventColumns(), rows: data.rows, empty: 'No changes recorded yet. Events appear after the second daily snapshot.' }),
        pager(st, data.total, (o) => { st.offset = o; load(); }));
    } catch (err) {
      clear(results).append(h('p', { class: 'empty' }, `Could not load activity: ${err.message}`));
    } finally {
      results.classList.remove('loading');
    }
  }

  clear(root).append(h('div', { class: 'stack' }, filterHost, card('Activity', 'what changed between daily snapshots, newest day first, biggest villages first', results)));
  await load();
}

async function viewMap(root, params, alive) {
  const holder = h('div');
  clear(root).append(h('div', { class: 'stack' }, card('Map', 'drag to pan, scroll or pinch to zoom, hover a village for details', holder)));
  holder.append(h('p', { class: 'empty' }, 'Loading the map...'));
  const data = await api('map');
  if (!alive()) return;
  if (data.empty) return renderEmpty(root);
  mapHandle = mountMap(holder, data, { player: params.get('player') || '', tag: params.get('tag') || '' });
}

function renderEmpty(root) {
  const st = statusCache;
  const last = st && st.ingest && st.ingest.lastResult;
  clear(root).append(card('Waiting for the first snapshot', null,
    h('p', null, 'Tra5x downloads the daily map.sql file from the game server and stores the statistics. Nothing has been stored yet.'),
    h('p', { class: 'muted' }, st ? `Source: ${st.source}` : ''),
    last ? h('p', null, `Last attempt: ${last.status} - ${last.message}`) : null,
    h('p', { class: 'muted' }, 'This page checks again automatically.')));
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await loadStatus();
    if (statusCache && statusCache.latest_snapshot) navigate();
    else if (root.isConnected) renderEmpty(root);
  }, 15000);
}

// ------------------------------------------------------------------ router
const routes = { overview: viewOverview, players: viewPlayers, alliances: viewAlliances, trends: viewTrends, activity: viewActivity, map: viewMap };
const titles = { overview: 'Overview', players: 'Players', alliances: 'Alliances', trends: 'Trends', activity: 'Activity', map: 'Map' };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { route: routes[path] ? path : 'overview', params: new URLSearchParams(qs || '') };
}

function disposeView() {
  clearTimeout(pollTimer);
  disposeCharts();
  if (mapHandle) mapHandle.dispose();
  mapHandle = null;
}

async function navigate() {
  const { route, params } = parseHash();
  token += 1;
  const mine = token;
  const alive = () => mine === token;
  disposeView();
  for (const d of document.querySelectorAll('dialog[open]')) d.close(); // e.g. browser Back while a modal is open
  document.title = `${titles[route]} - Tra5x`;
  for (const a of document.querySelectorAll('#nav a')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  clear(main).append(h('p', { class: 'empty' }, 'Loading...'));
  loadStatus();
  try {
    await routes[route](main, params, alive);
  } catch (err) {
    if (!alive()) return;
    clear(main).append(card('Something went wrong', null, h('p', null, err.message),
      h('p', null, h('button', { class: 'btn', type: 'button', onclick: navigate }, 'Try again'))));
  }
}

// ------------------------------------------------------------------ theme
function effectiveTheme() {
  return document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
$('#theme').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('tra5x-theme', next); } catch { /* storage unavailable */ }
  navigate();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!document.documentElement.getAttribute('data-theme')) navigate();
});

window.addEventListener('hashchange', navigate);
navigate();
