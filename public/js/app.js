import { h, $, clear, fmt, PLAYER_TRIBES, tribeName, tribeColor, seriesColor, cssVar, debounce, hideTooltip } from './util.js';
import { api } from './api.js';
import { lineChart, barChart, disposeCharts, tableView } from './charts.js';

const main = $('#view');
let token = 0;
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
 * columns: [{label, r?:bool, cell:(row)=>Node|string, sort?:string, hint?:string (tooltip on the header)}]
 * sort: {key, dir}; onSort(key)
 */
function dataTable({ columns, rows, sort, onSort, empty = 'Nothing to show.', rowClass, tableClass = '' }) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  const head = columns.map((c) => {
    const active = sort && c.sort && sort.key === c.sort;
    const label = c.sort && onSort ? h('button', { type: 'button', onclick: () => onSort(c.sort), 'aria-label': `Sort by ${c.label}` }, c.label, active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '') : c.label;
    const th = h('th', { class: c.r ? 'r' : '', scope: 'col', title: c.hint || null }, label);
    if (active) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
    return th;
  });
  return h('div', { class: 'tablewrap' },
    h('table', { class: tableClass }, h('thead', null, h('tr', null, head)),
      h('tbody', null, rows.map((row) => h('tr', { class: rowClass ? rowClass(row) : '' }, columns.map((c) => h('td', { class: c.r ? 'r num' : '' }, c.cell(row))))))));
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
    body.append(h('p', null,
      h('a', { href: `#/compare?player=${encodeURIComponent(p.name)}`, onclick: () => body.closest('dialog').close() }, 'Compare with the players around')));
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
    const chart = h('div');
    body.append(h('h3', null, 'Population over time'), chart);
    if (history.length >= 2) lineChart(chart, { series: [{ label: 'Population', color: seriesColor(1), points: history.map((r) => ({ t: Date.parse(r.taken_at), v: r.population })) }], height: 200, ariaLabel: `Population history of ${a.tag}` });
    else chart.append(h('p', { class: 'muted' }, 'Needs at least two daily snapshots.'));
    body.append(h('h3', null, `Members (top ${Math.min(50, members.total)} by population)`),
      dataTable({ columns: playerColumns({ withRank: false }).filter((c) => c.label !== 'Alliance'), rows: members.rows }));
    if (events && events.length) body.append(h('h3', null, 'Recent activity'), dataTable({ columns: eventColumns(), rows: events }));
  });
}

async function openRegion(key) {
  openModal('Region', async (body) => {
    body.append(h('p', { class: 'empty' }, 'Loading...'));
    const d = await api('regions', { key });
    clear(body);
    body.previousSibling.firstChild.textContent = d.region;
    body.append(h('div', { class: 'facts' },
      h('span', null, 'Rank ', h('b', null, `#${fmt.int(d.rank)} of ${fmt.int(d.regions_tracked)}`)),
      h('span', null, 'Villages ', h('b', null, fmt.int(d.totals.villages))),
      h('span', null, 'Population ', h('b', null, fmt.int(d.totals.population))),
      h('span', null, 'Avg population / village ', h('b', null, fmt.dec(d.totals.avg_population)))));

    const chart = h('div');
    body.append(h('h3', null, 'Population over time'), chart);
    if (d.history.length >= 2) {
      lineChart(chart, { series: [{ label: 'Population', color: seriesColor(1), points: d.history.map((r) => ({ t: Date.parse(r.taken_at), v: r.population })) }], height: 200, ariaLabel: `Population history of ${d.region}` });
    } else {
      chart.append(h('p', { class: 'muted' }, 'Regions are recorded once a day; the chart needs at least two daily snapshots.'));
    }

    const growthLine = (label, g) => h('p', null, `${label}: `,
      g ? [deltaNode(g.villages_gain, { suffix: ' villages' }), ', ', deltaNode(g.population_gain, { suffix: ' population' })] : h('span', { class: 'muted' }, 'not enough history yet'));
    body.append(h('h3', null, 'Change over time'), growthLine('Last 24h', d.growth.d1), growthLine('Last 3 days', d.growth.d3), growthLine('Last 7 days', d.growth.d7));

    body.append(h('h3', null, 'Alliances that dominate this region'));
    if (!d.alliances_available) {
      body.append(h('p', { class: 'muted' }, 'Village-level detail is not available yet; it fills in with the next daily snapshot.'));
    } else if (!d.alliances.length) {
      body.append(h('p', { class: 'empty' }, 'No occupied villages found here right now.'));
    } else {
      body.append(dataTable({
        columns: [
          { label: 'Alliance', cell: (a) => (a.alliance_id ? nameButton(`[${a.alliance_tag || a.alliance_id}]`, () => { body.closest('dialog').close(); openAlliance(a.alliance_id); }) : h('span', { class: 'muted' }, 'No alliance')) },
          { label: 'Villages', r: true, cell: (a) => fmt.int(a.villages) },
          { label: 'Share', r: true, cell: (a) => fmt.pct(a.village_share, 0) },
          { label: 'Population', r: true, cell: (a) => fmt.int(a.population) },
          { label: 'Share', r: true, cell: (a) => fmt.pct(a.population_share, 0) },
        ],
        rows: d.alliances,
      }), h('p', { class: 'muted' }, "Live as of this region's latest snapshot; Natar villages are not counted."));
    }
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

// ------------------------------------------------------------------ compare
const COMPARE_PERIODS = [[1, '1 day'], [7, '7 days'], [30, '30 days'], [0, 'Since start']];
const COMPARE_RADII = [25, 50, 75, 100]; // fields
const DEFAULT_RADIUS = 50;
const pctSigned = (r) => (r === null || r === undefined ? '-' : `${r > 0 ? '+' : r < 0 ? '-' : ''}${(Math.abs(r) * 100).toFixed(1)}%`);
const ASC_FIRST = new Set(['name', 'rank', 'distance', 'centre_distance']);
const pt = (c) => `(${c.x}|${c.y})`;
const ptsSigned = (r) => (r === null || r === undefined ? '-' : `${r > 0 ? '▲ +' : r < 0 ? '▼ -' : ''}${(Math.abs(r) * 100).toFixed(1)} pts`);

/** Sorts rows on a numeric or text key; missing values always go last. */
function sortLocal(rows, { key, dir }) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return a.rank - b.rank;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sign || a.rank - b.rank;
  });
}

/** Two distance columns: closest approach (headline) and centre-to-centre with the player's spread. */
function distanceColumns(radius) {
  const none = (text = '-') => h('span', { class: 'muted' }, text);
  return [
    {
      label: 'Distance (fields)',
      hint: 'Closest approach: the shortest distance from your starting village(s) to any village of theirs. The coordinates are the two villages.',
      r: true,
      sort: 'distance',
      cell: (r) => {
        if (r.is_me) return none('you');
        if (r.distance === null) return none();
        return h('span', { title: `Closest pair of villages: yours ${pt(r.closest.you)}, theirs ${pt(r.closest.them)}` },
          fmt.dec(r.distance), h('span', { class: 'coords' }, `${pt(r.closest.you)} → ${pt(r.closest.them)}`));
      },
    },
    {
      label: 'In range',
      hint: `How many of their villages are within ${radius} fields of one of yours`,
      r: true,
      sort: 'villages_in_range',
      cell: (r) => (r.is_me ? none('you') : h('span', { title: `${r.villages_in_range} of their ${r.villages} villages are within ${radius} fields of one of yours` }, `${fmt.int(r.villages_in_range)} of ${fmt.int(r.villages)}`)),
    },
    {
      label: 'Centre (fields)',
      hint: 'Distance between the population-weighted centres of the two players. Spread = how far that player\'s villages lie from their own centre, on average.',
      r: true,
      sort: 'centre_distance',
      cell: (r) => {
        if (r.centre === null) return none();
        const spread = h('span', { class: 'coords' }, `spread ${fmt.dec(r.spread)}`);
        const title = `Centre ${pt(r.centre)}, spread ${fmt.dec(r.spread)} fields`;
        if (r.is_me) return h('span', { title }, none('you'), spread);
        if (r.centre_distance === null) return h('span', { title }, none(), spread);
        return h('span', { title }, fmt.dec(r.centre_distance), spread);
      },
    },
  ];
}

/** Extra KPI tiles: where you live and who is your nearest neighbour. */
function locationTiles(d, kpi) {
  const tiles = [];
  const loc = d.location;
  if (loc) {
    const main = loc.main ? `${loc.main.capital ? 'capital' : 'biggest village'} ${pt(loc.main)}` : '';
    if (loc.centre) tiles.push(kpi('Your centre', pt(loc.centre), `${fmt.int(loc.villages)} ${loc.villages === 1 ? 'village' : 'villages'}, spread ${fmt.dec(loc.spread)} fields${main ? `; ${main}` : ''}`, true));
    else if (loc.main) tiles.push(kpi('Your location', pt(loc.main), `${main}; villages too widely spread for one centre`, true));
  }
  const near = d.rows.filter((r) => !r.is_me && r.distance !== null).sort((a, b) => a.distance - b.distance || a.rank - b.rank)[0];
  if (near) tiles.push(kpi('Nearest of these', `${fmt.dec(near.distance)} fields`, `${near.name}${near.alliance_tag ? ` [${near.alliance_tag}]` : ''}, closest villages`));
  return tiles;
}

/** Plain-language explanation of how the distances are calculated, adapted to the world geometry in use. */
function distanceNote(g, radius, origin) {
  const size = g.size ? `${g.size} × ${g.size}` : 'unknown size';
  const where = g.wrap
    ? `The map wraps around like a globe (${size} fields, coordinates -${g.radius} to ${g.radius}), so a village at the far east edge is next to one at the far west edge. The shorter way round is always the one measured.`
    : 'This world is treated as having hard edges, so nothing wraps around.';
  const source = g.source === 'configured' ? 'The map size comes from the server settings.' : 'The map size is read from the extent of the tiles in the game\'s map.sql file.';
  return h('details', { class: 'how' },
    h('summary', null, 'How nearby players are found and distance is measured'),
    h('p', null, h('strong', null, `Who is listed. `), `A player is listed when at least one of their villages is within ${radius} fields of ${origin === 'main' ? 'your capital (or biggest village, if you have no capital)' : 'at least one of your villages'}, which is the same as their closest approach (below) being ${radius} or less. Their other villages may be much further away. ${origin === 'main' ? 'Choose "All my villages" to include everyone who is near any of your villages.' : 'With villages scattered over the map this list can get long: choose "Capital" to measure from one village.'} The # column ranks the listed players by population, so #1 is the biggest of the people around you; it is not the world ranking.`),
    h('p', null, h('strong', null, 'Fields. '), `Distance is the straight line between two villages: the square root of (x difference squared + y difference squared), the same as Travian's own distance. ${where} ${source}`),
    h('p', null, h('strong', null, 'Distance (closest approach). '), `Villages are scattered, so a player is not a single point. This column is the shortest distance between ${origin === 'main' ? 'your capital' : 'any village of yours'} and any village of theirs, which is the distance at which the two of you can actually reach each other: troops, reinforcements and traders travel from village to village. The coordinates under the number are the two villages that produce it.`),
    h('p', null, h('strong', null, 'Centre distance. '), 'A second view of the same question: where each player lives overall. Each player\'s village coordinates are averaged, weighted by village population, and the centre distance is the distance between your centre and theirs. The "spread" under it is how far, on average, that player\'s villages lie from their own centre. When the spread is large compared with the centre distance the centre falls between clusters, so rely on the closest approach instead.'),
    h('p', { class: 'muted' }, 'Travel time is not shown because it depends on unit speed, server speed and your tournament square; the distance in fields is what those are calculated from.'));
}

async function viewCompare(root, params, alive) {
  let name = params.get('player') || '';
  if (!name) {
    try { name = localStorage.getItem('tra5x-me') || ''; } catch { /* storage unavailable */ }
  }
  const st = {
    days: params.has('days') ? Number(params.get('days')) : 7,
    radius: COMPARE_RADII.includes(Number(params.get('radius'))) ? Number(params.get('radius')) : DEFAULT_RADIUS,
    origin: params.get('origin') === 'all' ? 'all' : 'main',
    sort: { key: 'rank', dir: 'asc' },
    metric: 'gain',
  };
  if (!COMPARE_PERIODS.some(([d]) => d === st.days)) st.days = 7;

  const out = h('div', { class: 'stack' });
  const periodHost = h('div');
  const radiusHost = h('div');
  const originHost = h('div');
  const nameIn = h('input', { type: 'search', id: 'cname', placeholder: 'your player name', value: name, autocomplete: 'off', 'aria-label': 'Player name' });
  const form = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); name = nameIn.value.trim(); load(); } },
    h('label', null, 'Player', nameIn), h('div', { class: 'field' }, h('span', null, 'Growth period'), periodHost),
    h('div', { class: 'field' }, h('span', null, 'Within (fields)'), radiusHost),
    h('div', { class: 'field' }, h('span', null, 'Measured from'), originHost),
    h('button', { class: 'btn', type: 'submit' }, 'Compare'));
  clear(root).append(h('div', { class: 'stack' }, form, out));

  const syncHash = () => {
    const q = new URLSearchParams();
    if (name) q.set('player', name);
    q.set('days', String(st.days));
    q.set('radius', String(st.radius));
    q.set('origin', st.origin);
    history.replaceState(null, '', `#/compare?${q}`);
  };

  function drawControls() {
    clear(periodHost).append(segmented(COMPARE_PERIODS, st.days, (d) => { st.days = d; load(); }, 'Growth period'));
    clear(originHost).append(segmented([['main', 'Capital'], ['all', 'All my villages']], st.origin, (o) => { st.origin = o; load(); }, 'Measure the distance from all your villages or only from your capital'));
    clear(radiusHost).append(segmented(COMPARE_RADII.map((r) => [r, String(r)]), st.radius, (r) => { st.radius = r; load(); }, 'Distance from your villages, in fields'));
  }

  function drawResult(d) {
    const me = d.me;
    const sum = d.summary;
    const p = d.period;
    clear(out);
    if (!p) {
      out.append(card('Growth needs two snapshots', null, h('p', null, `Only ${d.snapshots_stored} daily snapshot is stored so far. The ranking below is current; growth appears after the next daily map.sql refresh (server midnight).`)));
    }

    const days = p ? p.actual_days : null;
    const periodText = !p ? '' : st.days === 0 ? `since the first snapshot (${fmt.dec(days)} days)` : `over ${fmt.dec(days)} days`;
    const kpi = (label, value, note, small = false) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: small ? 'value num small' : 'value num' }, value), note ? h('div', { class: 'delta' }, note) : null);
    out.append(h('div', { class: 'kpis' },
      kpi('Your rank nearby', `#${fmt.int(me.rank)} of ${fmt.int(d.rows.length)}`, `by population, among players within ${fmt.int(d.radius)} fields of ${d.origin === 'main' && d.location && d.location.main ? `your ${d.location.main.capital ? 'capital' : 'biggest village'} ${pt(d.location.main)}` : 'your villages'}`),
      kpi('Your growth', me.gain === null ? '-' : fmt.signed(me.gain), me.gain_pct === null ? 'needs two snapshots' : `${pctSigned(me.gain_pct)} ${periodText}`),
      kpi('Median around you', sum.median_gain_pct === null ? '-' : pctSigned(sum.median_gain_pct), sum.median_gain === null ? '' : `${fmt.signed(Math.round(sum.median_gain))} population, ${sum.compared} players`),
      kpi('Your growth rank', sum.my_growth_position === null ? '-' : `${sum.my_growth_position} of ${sum.compared + 1}`, sum.faster === null ? '' : `${sum.faster} grew faster, ${sum.slower} slower`),
      kpi('Population', fmt.int(me.population), `${fmt.int(me.villages)} ${me.villages === 1 ? 'village' : 'villages'}${me.village_gain ? `, ${fmt.signed(me.village_gain)} ${periodText}` : ''}`),
      ...locationTiles(d, kpi)));
    if (p && p.truncated) {
      out.append(h('p', { class: 'muted' }, `Only ${fmt.dec(p.actual_days)} days of history are stored, so growth covers that instead of the ${st.days} days you asked for.`));
    }

    // chart: me against the nearest ranks
    const chartHost = h('div');
    const times = d.series.times.map((t) => Date.parse(t));
    const drawChart = () => {
      const series = d.series.players.map((pl, i) => {
        const pts = [];
        let base = null;
        pl.points.forEach((v, k) => {
          if (v === null) return;
          if (base === null) base = v;
          pts.push({ t: times[k], v: st.metric === 'gain' ? v - base : v });
        });
        return { label: pl.is_me ? `${pl.name} (you)` : pl.name, color: pl.is_me ? cssVar('--ink') : seriesColor(Math.min(8, i + 1)), points: pts };
      });
      lineChart(chartHost, { series, height: 260, zeroBase: st.metric === 'gain', ariaLabel: st.metric === 'gain' ? 'Population gained since the start of the period, you against nearby players' : 'Population over time, you against nearby players' });
    };
    const metricHost = h('div', { class: 'filters' });
    const drawMetric = () => clear(metricHost).append(segmented([['gain', 'Gained since start'], ['population', 'Population']], st.metric, (m) => { st.metric = m; drawMetric(); drawChart(); }, 'Chart metric'));
    if (times.length >= 2) {
      drawMetric();
      drawChart();
      out.append(card('You against players of similar size', 'the nearby players closest to you in population', metricHost, chartHost));
    }

    // table
    const tableHost = h('div');
    const columns = [
      { label: '#', r: true, sort: 'rank', cell: (r) => fmt.int(r.rank) },
      { label: 'Player', sort: 'name', cell: (r) => h('span', null, nameButton(r.name, () => openPlayer(r.id)), r.is_me ? ' (you)' : '', h('span', { class: 'coords' }, tribeCell(r.tribe))) },
      { label: 'Alliance', cell: (r) => (r.alliance_id ? nameButton(`[${r.alliance_tag || r.alliance_id}]`, () => openAlliance(r.alliance_id)) : h('span', { class: 'muted' }, '-')) },
      ...distanceColumns(d.radius),
      { label: 'Population', r: true, sort: 'population', cell: (r) => fmt.int(r.population) },
      { label: 'Growth', r: true, sort: 'gain', cell: (r) => deltaNode(r.gain) },
      { label: 'Growth %', r: true, sort: 'gain_pct', cell: (r) => (r.gain_pct === null ? h('span', { class: 'muted' }, p ? 'new' : '-') : h('span', { class: r.gain_pct > 0 ? 'up' : r.gain_pct < 0 ? 'down' : 'muted' }, pctSigned(r.gain_pct))) },
      { label: 'vs you', r: true, sort: 'vs_me_pct', cell: (r) => (r.is_me ? h('span', { class: 'muted' }, 'you') : h('span', { title: 'Difference in growth %, in percentage points. ▲ = grew faster than you, ▼ = slower.' }, ptsSigned(r.vs_me_pct))) },
      { label: 'Villages', r: true, sort: 'villages', cell: (r) => fmt.int(r.villages) },
      { label: 'Village change', r: true, sort: 'village_gain', cell: (r) => deltaNode(r.village_gain) },
      { label: 'Rank change', r: true, sort: 'rank_change', cell: (r) => deltaNode(r.rank_change) },
    ];
    const drawTable = () => {
      clear(tableHost).append(dataTable({
        columns,
        tableClass: 'compact',
        rows: sortLocal(d.rows, st.sort),
        sort: st.sort,
        rowClass: (r) => (r.is_me ? 'me' : ''),
        onSort: (key) => {
          if (st.sort.key === key) st.sort = { key, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' };
          else st.sort = { key, dir: ASC_FIRST.has(key) ? 'asc' : 'desc' }; // nearest first for distances
          drawTable();
        },
      }));
    };
    drawTable();
    const shown = d.rows.length - 1;
    const sub = shown === 0 ? `nobody else within ${fmt.int(d.radius)} fields` : `${fmt.int(shown)} ${shown === 1 ? 'player' : 'players'} with a village within ${fmt.int(d.radius)} fields of ${d.origin === 'main' ? 'your capital' : 'yours'}${p ? `, growth ${periodText}` : ''}`;
    out.append(card(`Players within ${fmt.int(d.radius)} fields`, sub,
      shown === 0 ? h('p', { class: 'empty' }, `No other player has a village within ${fmt.int(d.radius)} fields of ${d.origin === 'main' ? 'your capital' : 'yours'}. Try a bigger distance.`) : null,
      d.nearby.truncated ? h('p', { class: 'muted' }, `${fmt.int(d.nearby.total)} players are in range; the ${fmt.int(d.nearby.shown)} nearest are listed. Choose a smaller distance to see everyone.`) : null,
      h('p', { class: 'muted' }, '# ranks these players by population (1 = most). "vs you" compares growth %: ▲ grew faster than you, ▼ slower. Rank change: places gained (▲) or lost (▼) among these players.'),
      tableHost, distanceNote(d.geometry, d.radius, d.origin)));
  }

  function drawNotFound(err) {
    const sugg = (err.body && err.body.suggestions) || [];
    clear(out).append(card('Player not found', null,
      h('p', null, err.message),
      sugg.length
        ? h('p', null, 'Did you mean: ', sugg.map((x, i) => [i ? ', ' : '', nameButton(`${x.name}${x.alliance_tag ? ` [${x.alliance_tag}]` : ''}`, () => { nameIn.value = x.name; name = x.name; load(); })]))
        : h('p', { class: 'muted' }, 'The name must match exactly (upper and lower case are ignored). Use the Players tab to search for part of a name.')));
  }

  async function load() {
    drawControls();
    syncHash();
    if (!name) {
      clear(out).append(card('Compare with the players near you', null,
        h('p', null, 'Enter your player name to see every player with a village within 50 fields of yours (you can change the distance), ranked among themselves, and how much each of them has grown compared with you.'),
        h('p', { class: 'muted' }, 'Growth is measured between the daily snapshots Tra5x has stored, so the longer periods fill in as history builds up.')));
      return;
    }
    out.classList.add('loading');
    try {
      const data = await api('compare', { player: name, days: st.days, radius: st.radius, origin: st.origin });
      if (!alive()) return;
      try { localStorage.setItem('tra5x-me', data.me.name); } catch { /* storage unavailable */ }
      drawResult(data);
    } catch (err) {
      if (!alive()) return;
      if (err.status === 404) drawNotFound(err);
      else clear(out).append(h('p', { class: 'empty' }, `Could not load the comparison: ${err.message}`));
    } finally {
      out.classList.remove('loading');
    }
  }
  await load();
}

// ------------------------------------------------------------------ regions
const REGION_RANGES = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [0, 'All']];
const REGION_TOP_N = 5; // regions plotted on the trend chart, same as "Top alliances" in Trends
const REGION_CAP = 500; // matches the cap in aggregate.js: only the busiest regions are tracked in history

/** Sorts region rows on a numeric or text key; missing values (no data at the reference snapshot) go last. */
function sortRegions(rows, { key, dir }) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = a[key];
    const y = b[key];
    if (x == null && y == null) return b.villages - a.villages;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sign || b.villages - a.villages;
  });
}

/** Breakdown rows (one per snapshot x region) grouped by snapshot, oldest first: {taken_at, regions: Map(key -> {villages, population})}. */
function regionSnapshots(data) {
  const bySnap = new Map(data.snapshots.map((snap) => [snap.taken_at, new Map()]));
  for (const r of data.rows) {
    const m = bySnap.get(r.taken_at);
    if (m) m.set(r.key, { villages: r.villages, population: r.population });
  }
  return data.snapshots.map((snap) => ({ taken_at: snap.taken_at, regions: bySnap.get(snap.taken_at) }));
}

async function viewRegions(root, params, alive) {
  let days = params.has('days') ? Number(params.get('days')) : 30;
  let metric = params.get('metric') === 'population' ? 'population' : 'villages';
  if (!REGION_RANGES.some(([d]) => d === days)) days = 30;
  const body = h('div', { class: 'stack' });
  const rangeHost = h('div', { class: 'filters' });
  clear(root).append(h('div', { class: 'stack' }, rangeHost, body));

  const syncHash = () => {
    const q = new URLSearchParams();
    q.set('days', String(days));
    q.set('metric', metric);
    history.replaceState(null, '', `#/regions?${q}`);
  };

  function draw(data) {
    const snaps = regionSnapshots(data);
    if (!snaps.length) {
      clear(body).append(card('Regional overview', null, h('p', { class: 'empty' }, 'No snapshot has been stored yet.')));
      return;
    }
    if (!snaps.some((snap) => snap.regions.size)) {
      clear(body).append(card('Regional overview', null,
        h('p', { class: 'empty' }, "No region data in this world's map.sql export. Not every Travian world labels its villages with a region.")));
      return;
    }
    const latest = snaps[snaps.length - 1];
    const previous = snaps.length >= 2 ? snaps[snaps.length - 2] : null;

    const regions = [...latest.regions.entries()]
      .map(([key, cur]) => {
        const prev = previous ? previous.regions.get(key) : null;
        return {
          key,
          villages: cur.villages,
          population: cur.population,
          avg_pop: cur.villages ? cur.population / cur.villages : 0,
          village_gain: prev ? cur.villages - prev.villages : null,
          population_gain: prev ? cur.population - prev.population : null,
        };
      })
      .sort((a, b) => b.villages - a.villages || a.key.localeCompare(b.key));

    const totalVillages = regions.reduce((sum, r) => sum + r.villages, 0);
    const totalPopulation = regions.reduce((sum, r) => sum + r.population, 0);
    const biggest = regions[0];
    const fastest = previous ? [...regions].filter((r) => r.population_gain !== null).sort((a, b) => b.population_gain - a.population_gain)[0] : null;

    const kpi = (label, value, note) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value num' }, value), note ? h('div', { class: 'delta' }, note) : null);
    const kpis = h('div', { class: 'kpis' },
      kpi('Regions tracked', fmt.int(regions.length), regions.length >= REGION_CAP ? `capped at the ${fmt.int(REGION_CAP)} busiest` : `${fmt.int(totalVillages)} villages, ${fmt.int(totalPopulation)} population`),
      biggest ? kpi('Biggest region', biggest.key, `${fmt.int(biggest.villages)} villages, ${fmt.int(biggest.population)} population`) : null,
      fastest && fastest.population_gain !== null ? kpi('Fastest growing', fastest.key, [deltaNode(fastest.population_gain), ' population since the previous snapshot']) : null);

    // trend chart: the regions biggest right now, tracked over the selected range
    const chartHost = h('div');
    const metricHost = h('div', { class: 'filters' });
    const top = regions.slice(0, REGION_TOP_N).map((r) => r.key);
    const drawChart = () => {
      clear(metricHost).append(segmented([['villages', 'Villages'], ['population', 'Population']], metric, (m) => { metric = m; syncHash(); drawChart(); }, 'Chart metric'));
      const series = top.map((key, i) => ({
        label: key,
        color: seriesColor(i + 1),
        points: snaps.filter((snap) => snap.regions.has(key)).map((snap) => ({ t: Date.parse(snap.taken_at), v: snap.regions.get(key)[metric] })),
      }));
      lineChart(chartHost, { series, height: 260, ariaLabel: `${metric === 'villages' ? 'Villages' : 'Population'} of the biggest regions over time` });
    };
    drawChart();

    // full table: every tracked region as of the latest snapshot, with a live text filter
    const tableHost = h('div');
    const sort = { key: 'villages', dir: 'desc' };
    let filter = '';
    const columns = [
      { label: 'Region', sort: 'key', cell: (r) => nameButton(r.key, () => openRegion(r.key)) },
      { label: 'Villages', r: true, sort: 'villages', cell: (r) => fmt.int(r.villages) },
      { label: 'Village change', r: true, sort: 'village_gain', cell: (r) => deltaNode(r.village_gain) },
      { label: 'Population', r: true, sort: 'population', cell: (r) => fmt.int(r.population) },
      { label: 'Population change', r: true, sort: 'population_gain', cell: (r) => deltaNode(r.population_gain) },
      { label: 'Avg population / village', r: true, sort: 'avg_pop', cell: (r) => fmt.dec(r.avg_pop) },
    ];
    const drawTable = () => {
      const rows = filter ? regions.filter((r) => r.key.toLowerCase().includes(filter)) : regions;
      clear(tableHost).append(dataTable({
        columns,
        rows: sortRegions(rows, sort),
        sort,
        empty: filter ? `No region name contains "${filter}".` : 'No regions tracked.',
        onSort: (key) => {
          if (sort.key === key) sort.dir = sort.dir === 'asc' ? 'desc' : 'asc';
          else {
            sort.key = key;
            sort.dir = key === 'key' ? 'asc' : 'desc';
          }
          drawTable();
        },
      }));
    };
    drawTable();
    const searchIn = h('input', {
      type: 'search',
      placeholder: 'region contains...',
      autocomplete: 'off',
      'aria-label': 'Search regions',
      oninput: (e) => { filter = e.target.value.trim().toLowerCase(); drawTable(); },
    });

    clear(body).append(
      kpis,
      card('Biggest regions over time', `top ${Math.min(REGION_TOP_N, regions.length)} by villages right now`, metricHost, chartHost,
        snaps.length < 2 ? h('p', { class: 'muted' }, 'Trends appear after the next daily map.sql refresh (server midnight).') : null),
      card('Regional overview', previous ? `${fmt.date(latest.taken_at)}, change since the previous snapshot; click a region for details` : `${fmt.date(latest.taken_at)}; click a region for details`,
        h('div', { class: 'filters' }, h('label', null, 'Search', searchIn)), tableHost,
        h('p', { class: 'muted' }, `Regions come from the "region" field in map.sql, Travian's own labelling of villages; not every world uses it. Up to the ${fmt.int(REGION_CAP)} busiest regions are tracked.`)));
  }

  async function load() {
    clear(rangeHost).append(segmented(REGION_RANGES, days, (d) => { days = d; syncHash(); load(); }, 'Time range'));
    syncHash();
    body.classList.add('loading');
    let data;
    try {
      data = await api('breakdowns', { kind: 'region', days });
    } catch (err) {
      body.classList.remove('loading');
      clear(body).append(h('p', { class: 'empty' }, `Could not load regions: ${err.message}`));
      return;
    }
    if (!alive()) return;
    body.classList.remove('loading');
    disposeCharts();
    draw(data);
  }
  await load();
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
const routes = { overview: viewOverview, players: viewPlayers, alliances: viewAlliances, trends: viewTrends, activity: viewActivity, compare: viewCompare, regions: viewRegions };
const titles = { overview: 'Overview', players: 'Players', alliances: 'Alliances', trends: 'Trends', activity: 'Activity', compare: 'Compare', regions: 'Regions' };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { route: routes[path] ? path : 'overview', params: new URLSearchParams(qs || '') };
}

function disposeView() {
  clearTimeout(pollTimer);
  disposeCharts();
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
