/* The dashboard reads the snapshot the box pushes to the `data` branch of this repository.
 *
 * Why raw and not a file next to the page: GitHub Pages has a soft limit of 10 builds per hour,
 * while the snapshot changes every two minutes. The snapshot lives in a branch Pages never
 * builds, so there are no rebuilds at all. The price is the raw cache (up to ~5 minutes), so the
 * snapshot age is always shown in the header instead of pretending to be live.
 *
 * Three tabs. Instruments — the outcome: what is collected into the database and how it is
 * going (default). Pipeline — a candidate's path from discovery to collection. Log — runs,
 * spend, accesses. The tab and the filters live in `#hash`, so a view can be shared as a link.
 */
const SNAPSHOT_DEFAULT = 'https://raw.githubusercontent.com/detracker/ai-sandbox-dashboard/data/snapshot.json';
// `?snapshot=local.json` — preview the page on a local snapshot before publishing. Relative
// paths only: a link must not be able to point the public page at someone else's data. The
// path starts with a name, never with `/`: `//evil.example/x.json` is a protocol-relative URL
// to another host (audit 2026-10-07, A-045).
const SNAPSHOT_PARAM = new URLSearchParams(location.search).get('snapshot');
const SNAPSHOT_LOCAL = /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)*\.json$/;
const SNAPSHOT = SNAPSHOT_PARAM && SNAPSHOT_LOCAL.test(SNAPSHOT_PARAM) && !SNAPSHOT_PARAM.includes('..') ? SNAPSHOT_PARAM : SNAPSHOT_DEFAULT;
const SUPPORTED_SCHEMA = 1;
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

const STATUS = {
  stalled: { sign: '🔴', label: 'stalled', one: 'stalled', order: 0 },
  lagging: { sign: '🟠', label: 'lagging', one: 'lagging', order: 1 },
  backfilling: { sign: '🔵', label: 'backfilling', one: 'backfilling history', order: 2 },
  pending: { sign: '⏳', label: 'pending', one: 'awaiting first collector run', order: 3 },
  collecting: { sign: '🟢', label: 'collecting', one: 'collecting', order: 4 },
  disabled: { sign: '⚪', label: 'disabled', one: 'disabled', order: 5 },
};
const ACTIVE = ['proposed', 'analyzing', 'spec_ready', 'critiquing', 'needs_rework', 'approved', 'implementing', 'blocked'];

const state = { tab: 'instruments', status: 'all', source: 'agents', protocol: 'all', q: '', history: 'all', stage: 'all', result: 'all' };
let snapshot = null;

/* --- state in #hash ------------------------------------------------------------------ */

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const key of Object.keys(state)) {
    if (params.has(key)) state[key] = params.get(key);
  }
  if (!['instruments', 'pipeline', 'health', 'log'].includes(state.tab)) state.tab = 'instruments';
}

function writeHash() {
  const params = new URLSearchParams();
  const defaults = { tab: 'instruments', status: 'all', source: 'agents', protocol: 'all', q: '', history: 'all', stage: 'all', result: 'all' };
  for (const [key, value] of Object.entries(state)) {
    if (value !== defaults[key]) params.set(key, value);
  }
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function setState(patch) {
  Object.assign(state, patch);
  writeHash();
  if (snapshot) render(snapshot);
}

/* --- loading ------------------------------------------------------------------------- */

async function load() {
  try {
    const response = await fetch(`${SNAPSHOT}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    snapshot = await response.json();
    render(snapshot);
  } catch (error) {
    $('age').textContent = 'snapshot unavailable';
    $('age').classList.add('stale');
    $('source').textContent = String(error);
  }
}

function render(data) {
  if (data.schema_version !== SUPPORTED_SCHEMA) {
    // Better to say so than to silently show the wrong thing: field meanings may have changed.
    $('source').textContent = `snapshot schema ${data.schema_version}, this page understands ${SUPPORTED_SCHEMA} — reload the page`;
  } else {
    $('source').textContent = `snapshot of ${data.generated_at}`;
  }
  renderAge(data.generated_at);
  renderHealth(data);
  renderTabs(data);
  renderInstruments(data);
  renderPipeline(data);
  renderHealthTab(data);
  renderLog(data);
}

/* --- header ------------------------------------------------------------------------ */

function renderAge(generatedAt) {
  const minutes = minutesSince(generatedAt);
  const node = $('age');
  node.textContent = minutes !== null && minutes < 1 ? 'snapshot just now' : `snapshot ${humanAge(minutes)} ago`;
  // Over 15 minutes means the timer on the box did not fire, and that must be visible at once.
  node.classList.toggle('stale', minutes !== null && minutes > 15);
}

function renderHealth(data) {
  const parts = [];
  if (data.stopped) {
    // The reason is free text from the orchestrator (not in English) — kept as a tooltip.
    parts.push(`<span class="pill fail" title="${esc(data.stopped)}">pipeline stopped</span>`);
  } else if (data.now) {
    const who = data.now.candidate && data.now.candidate !== '—' ? ` · ${esc(data.now.candidate)}` : '';
    parts.push(`<span class="pill run">running ${esc(data.now.stage)}${who} · ${humanAge(data.now.minutes)}</span>`);
  } else {
    parts.push('<span class="pill">pipeline idle</span>');
  }
  const waiting = (data.awaiting || []).length;
  if (waiting) parts.push(`<a class="pill accent" href="#tab=pipeline">awaiting decision: ${waiting}</a>`);
  // One pill for all dependencies: the worst state wins.
  const checks = (data.health && data.health.checks) || [];
  if (checks.length) {
    const down = checks.filter((c) => c.state === 'down').length;
    const degraded = checks.filter((c) => c.state === 'degraded').length;
    parts.push(
      down
        ? `<a class="pill fail" href="#tab=health">${down} down${degraded ? `, ${degraded} degraded` : ''}</a>`
        : degraded
          ? `<a class="pill accent" href="#tab=health">${degraded} degraded</a>`
          : '<a class="pill ok" href="#tab=health">all systems ok</a>',
    );
  }
  const problems = (data.instruments || []).filter((i) => i.status === 'stalled' || i.status === 'lagging');
  if (problems.length) {
    parts.push(`<a class="pill fail" href="#tab=instruments&source=all&status=stalled">collection issues: ${problems.length}</a>`);
  }
  $('health').innerHTML = parts.join('');
}

function renderTabs(data) {
  for (const button of document.querySelectorAll('[data-tab]')) {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active);
  }
  for (const tab of ['instruments', 'pipeline', 'health', 'log']) {
    $(`panel-${tab}`).classList.toggle('hidden', tab !== state.tab);
  }
  const items = data.instruments || [];
  $('tab-instruments').textContent = items.length ? items.filter((i) => i.source === 'agents').length : '';
  const waiting = (data.awaiting || []).length;
  $('tab-pipeline').textContent = waiting ? `⏳${waiting}` : '';
}

/* --- instruments --------------------------------------------------------------------- */

function renderInstruments(data) {
  const all = data.instruments;
  if (!all) {
    $('status-chips').innerHTML = '';
    $('source-switch').innerHTML = '';
    $('instruments-summary').textContent = '';
    $('instruments').innerHTML = '<p class="muted">registry unavailable: the database did not answer for the last snapshot</p>';
    return;
  }
  const bySource = state.source === 'all' ? all : all.filter((i) => i.source === state.source);

  // Source: added by agents is the sandbox's output; "all" also shows the legacy collection.
  const agents = all.filter((i) => i.source === 'agents').length;
  $('source-switch').innerHTML = [
    ['agents', `added by agents · ${agents}`],
    ['all', `all · ${all.length}`],
  ]
    .map(([key, label]) => `<button type="button" data-source="${key}" class="${state.source === key ? 'on' : ''}">${esc(label)}</button>`)
    .join('');

  // Protocols of the selected source, alphabetically by name.
  const protocols = [...new Map(bySource.map((i) => [i.protocol, i.protocol_name || i.protocol])).entries()].sort((a, b) =>
    String(a[1]).localeCompare(String(b[1])),
  );
  if (state.protocol !== 'all' && !protocols.some(([slug]) => slug === state.protocol)) state.protocol = 'all';
  $('protocol-filter').innerHTML =
    `<option value="all">all protocols</option>` +
    protocols.map(([slug, name]) => `<option value="${esc(slug)}"${slug === state.protocol ? ' selected' : ''}>${esc(name)}</option>`).join('');
  if ($('search').value !== state.q) $('search').value = state.q;

  const scoped = bySource.filter((i) => state.protocol === 'all' || i.protocol === state.protocol).filter(matches);

  // Status chips are both counters and the filter; empty ones are not shown.
  const counts = {};
  for (const item of scoped) counts[item.status] = (counts[item.status] || 0) + 1;
  const chips = [['all', `all · ${scoped.length}`, '']].concat(
    Object.entries(STATUS)
      .filter(([key]) => counts[key])
      .sort((a, b) => a[1].order - b[1].order)
      .map(([key, s]) => [key, `${s.sign} ${s.label} · ${counts[key]}`, key]),
  );
  if (state.status !== 'all' && !counts[state.status]) state.status = 'all';
  $('status-chips').innerHTML = chips
    .map(([key, label, cls]) => `<button type="button" data-status="${key}" class="fchip ${cls} ${state.status === key ? 'on' : ''}">${esc(label)}</button>`)
    .join('');

  const shown = scoped
    .filter((i) => state.status === 'all' || i.status === state.status)
    .sort(
      (a, b) =>
        (STATUS[a.status]?.order ?? 9) - (STATUS[b.status]?.order ?? 9) ||
        String(a.protocol_name || a.protocol).localeCompare(String(b.protocol_name || b.protocol)) ||
        String(a.element).localeCompare(String(b.element)),
    );

  $('instruments-summary').textContent = `showing ${shown.length} of ${all.length} · registry of ${shortTime(data.instruments_at)} UTC`;
  $('instruments').innerHTML = shown.length ? shown.map(instrumentCard).join('') : '<p class="muted">nothing matches the filter</p>';
}

function matches(item) {
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  return [item.protocol, item.protocol_name, item.element, item.element_name, item.address, item.asset, item.candidate]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(q));
}

function instrumentCard(item) {
  const s = STATUS[item.status] || { sign: '?', one: item.status };
  const m = item.metrics || {};
  const asset = item.asset || '';
  const metrics = [
    ['deposits', m.deposited != null ? `${compact(m.deposited)} ${asset}` : '—'],
    ['native rate', m.base_apr != null ? `${m.base_apr.toFixed(2)}%` : '—'],
    ['full rate', m.apr != null ? `${m.apr.toFixed(2)}%` : '—'],
  ];
  const progress =
    item.status === 'backfilling' && item.progress != null
      ? `<div class="progress" title="history loaded: ${item.progress}%"><span style="width:${Math.max(2, item.progress)}%"></span></div>
         <div class="hint">history ${Math.round(item.progress)}% · data as of ${shortDate(item.last_data)}</div>`
      : '';
  const freshness =
    item.status === 'backfilling'
      ? `writing, last ${minutesSince(item.last_write) < 1 ? 'just now' : `${humanAge(minutesSince(item.last_write))} ago`}`
      : item.last_data
        ? `data ${humanAge(minutesSince(item.last_data))} old`
        : 'no data';
  const links = [
    item.how_url && `<a href="${esc(item.how_url)}" target="_blank" rel="noopener" title="collection spec or collector code (GitLab, team access)">how it's collected ↗</a>`,
    item.mr_url && `<a href="${esc(item.mr_url)}" target="_blank" rel="noopener">MR ↗</a>`,
    item.issue_url && `<a href="${esc(item.issue_url)}" target="_blank" rel="noopener">decisions ↗</a>`,
    item.address && `<a href="https://etherscan.io/address/${esc(item.address)}" target="_blank" rel="noopener" class="mono">${esc(shortAddress(item.address))} ↗</a>`,
  ].filter(Boolean);
  return `<article class="inst ${esc(item.status)}">
    <div class="inst-head">
      <div>
        <div class="inst-protocol">${esc(item.protocol_name || item.protocol)}${item.source === 'agents' ? ' <span class="tag">agents</span>' : ''}</div>
        <div class="inst-name">${esc(item.element)}</div>
      </div>
      <span class="status ${esc(item.status)}">${s.sign} ${esc(s.one)}</span>
    </div>
    ${progress}
    <div class="inst-metrics">${metrics
      .map(([label, value]) => `<div><div class="metric-value small">${esc(value)}</div><div class="metric-label">${esc(label)}</div></div>`)
      .join('')}</div>
    <div class="inst-meta muted">${esc(freshness)} · series since ${esc(shortDate(item.first_data))} · <span class="mono">${esc(item.dag || '—')}</span></div>
    ${links.length ? `<div class="inst-links">${links.join('')}</div>` : ''}
  </article>`;
}

/* --- pipeline ------------------------------------------------------------------------ */

function renderPipeline(data) {
  const queue = data.queue || [];
  const agentsCollecting = (data.instruments || []).filter((i) => i.source === 'agents' && i.status !== 'disabled').length;
  const steps = [
    ['discovered', queue.length],
    ['screened out by researcher', queue.filter((c) => c.rejected_by === 'researcher').length],
    ['in progress', queue.filter((c) => ACTIVE.includes(c.status)).length],
    ['awaiting decision', (data.awaiting || []).length],
    ['rejected by a human', queue.filter((c) => c.status === 'rejected' && c.rejected_by !== 'researcher').length],
    ['implemented', queue.filter((c) => c.status === 'done').length],
    ['collecting', agentsCollecting],
  ];
  // A column with bars relative to "discovered": on a phone a row of arrows wraps at random
  // places, and each stage's share is exactly what a funnel should show.
  const base = Math.max(1, steps[0][1]);
  $('funnel').innerHTML = steps
    .map(
      ([label, n]) => `<div class="fstep">
        <span class="fstep-label">${esc(label)}</span>
        <span class="fstep-bar"><span style="width:${Math.min(100, (n / base) * 100)}%"></span></span>
        <span class="fstep-n">${n}</span>
      </div>`,
    )
    .join('');

  renderAwaiting(data.awaiting || []);
  renderNow(data.now);

  const active = queue.filter((c) => ACTIVE.includes(c.status));
  $('active-count').textContent = active.length ? `· ${active.length}` : '';
  $('active').innerHTML = active.length
    ? table(
        ['candidate', 'status', 'for', 'protocol', 'round'],
        active.map((row) => [cell(row.id, 'id'), badge(row.status), cell(humanAge(row.minutes_in_status)), cell(row.protocol || '—'), cell(row.round ?? '—', 'num')]),
      )
    : '<p class="muted">nothing in progress — the researcher searches once a day</p>';

  const kinds = [
    ['all', 'all'],
    ['done', 'implemented'],
    ['human', 'rejected by a human'],
    ['researcher', 'screened out'],
  ];
  $('history-chips').innerHTML = kinds
    .map(([key, label]) => `<button type="button" data-history="${key}" class="fchip ${state.history === key ? 'on' : ''}">${esc(label)}</button>`)
    .join('');
  const finished = queue
    .filter((c) => c.status === 'done' || c.status === 'rejected')
    .filter((c) => state.history === 'all' || (state.history === 'done' ? c.status === 'done' : c.status === 'rejected' && (c.rejected_by || 'human') === state.history))
    .sort((a, b) => (a.minutes_in_status ?? 1e9) - (b.minutes_in_status ?? 1e9));
  $('history').innerHTML = finished.length
    ? table(
        ['candidate', 'outcome', 'when', { text: 'protocol', cls: 'wide' }],
        finished.map((row) => [
          cell(row.id, 'id'),
          row.status === 'done'
            ? badge('done', 'implemented')
            : row.rejected_by === 'researcher'
              ? badge('skipped', 'screened out')
              : badge('rejected', 'rejected'),
          cell(`${humanAge(row.minutes_in_status)} ago`),
          cell(row.protocol || '—', 'wide'),
        ]),
      )
    : '<p class="muted">empty</p>';
}

function renderAwaiting(rows) {
  $('awaiting-box').classList.toggle('hidden', rows.length === 0);
  $('awaiting').innerHTML = rows
    .map(
      (row) => `<div class="await-row">
        <span class="await-id">${esc(row.id)}</span>
        <span>${esc(row.protocol || '')}</span>
        <span class="await-age">waiting ${humanAge(row.minutes_in_status)}</span>
        <span class="muted">verdict ${esc(row.verdict || '—')}${row.findings ? `, ${row.findings} findings` : ''}</span>
      </div>`,
    )
    .join('');
}

function renderNow(now) {
  const node = $('now');
  if (!now) {
    node.className = 'now-empty';
    node.textContent = 'nothing is running';
    return;
  }
  node.className = 'now-line';
  node.innerHTML = `<span class="now-stage">${esc(now.stage)}</span>
    <span>${esc(now.candidate || '—')}</span>
    <span class="muted">for ${humanAge(now.minutes)}</span>`;
}

/* --- health -------------------------------------------------------------------------- */

const HEALTH = {
  down: { sign: '🔴', label: 'down', order: 0 },
  degraded: { sign: '🟠', label: 'degraded', order: 1 },
  ok: { sign: '🟢', label: 'ok', order: 2 },
};

function renderHealthTab(data) {
  const health = data.health;
  const checks = (health && health.checks) || [];
  const down = checks.filter((c) => c.state === 'down').length;
  const degraded = checks.filter((c) => c.state === 'degraded').length;
  $('tab-health').textContent = down ? `🔴${down}` : degraded ? `🟠${degraded}` : '';
  if (!checks.length) {
    $('health-summary').textContent = '';
    $('health-groups').innerHTML = '<p class="muted">no health data yet — checks run every 15 minutes</p>';
    return;
  }
  const age = minutesSince(health.checked_at);
  $('health-summary').textContent =
    `${checks.length} dependencies · ${down} down · ${degraded} degraded · checked ${age !== null && age < 1 ? 'just now' : `${humanAge(age)} ago`}`;
  // Groups keep the box's order; inside a group problems go first.
  const groups = [...new Set(checks.map((c) => c.group))];
  $('health-groups').innerHTML = groups
    .map((group) => {
      const items = checks
        .filter((c) => c.group === group)
        .sort((a, b) => (HEALTH[a.state]?.order ?? 9) - (HEALTH[b.state]?.order ?? 9));
      return `<section class="card"><h2>${esc(group)}</h2><div class="deps">${items.map(dependencyRow).join('')}</div></section>`;
    })
    .join('');
}

function dependencyRow(check) {
  const s = HEALTH[check.state] || { sign: '?', label: check.state };
  const history = (check.history || [])
    .map((state) => `<span class="tick ${esc(state)}" title="${esc(state)}"></span>`)
    .join('');
  const incidents = (check.history || []).filter((state) => state !== 'ok').length;
  return `<div class="dep ${esc(check.state)}">
    <div class="dep-head">
      <span class="dep-title">${esc(check.title)}</span>
      <span class="status ${esc(check.state === 'ok' ? 'collecting' : check.state === 'down' ? 'stalled' : 'lagging')}">${s.sign} ${esc(s.label)}</span>
    </div>
    <div class="dep-summary mono">${esc(check.summary)}</div>
    <div class="dep-purpose muted">${esc(check.purpose)}</div>
    <div class="ticks" title="last 12 hours: ${incidents} of ${(check.history || []).length} checks not ok">${history}</div>
  </div>`;
}

/* --- log ----------------------------------------------------------------------------- */

function renderLog(data) {
  const totals = data.totals || {};
  const items = [
    ['runs', `${totals.runs_today ?? '—'} / ${totals.max_runs_per_day ?? '—'}`],
    ['spend, estimate', `$${(totals.cost_estimate_today_usd ?? 0).toFixed(2)}`],
    ['stage ceiling', `$${(totals.stage_ceiling_usd ?? 0).toFixed(0)}`],
    ['failures in a row', totals.consecutive_failures ?? 0],
  ];
  $('totals').innerHTML =
    '<div class="totals">' +
    items.map(([label, value]) => `<div><div class="metric-value">${esc(value)}</div><div class="metric-label">${esc(label)}</div></div>`).join('') +
    '</div>';
  $('cost-note').textContent = (data.notes || {}).cost_is_estimate || '';

  const runs = data.runs || [];
  const stages = [...new Set(runs.map((r) => r.stage))].sort();
  const results = [...new Set(runs.map((r) => r.status))].sort();
  if (state.stage !== 'all' && !stages.includes(state.stage)) state.stage = 'all';
  if (state.result !== 'all' && !results.includes(state.result)) state.result = 'all';
  $('stage-filter').innerHTML = `<option value="all">all stages</option>` + stages.map((s) => `<option${s === state.stage ? ' selected' : ''}>${esc(s)}</option>`).join('');
  $('result-filter').innerHTML = `<option value="all">any result</option>` + results.map((s) => `<option${s === state.result ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const shown = runs.filter((r) => (state.stage === 'all' || r.stage === state.stage) && (state.result === 'all' || r.status === state.result));
  $('runs').innerHTML = shown.length
    ? table(
        ['started (UTC)', 'stage', 'result', 'turns', 'estimate, $', 'candidate'],
        shown.map((row) => [
          cell(shortTime(row.started_at), 'id'),
          cell(row.stage),
          badge(row.status),
          cell(row.turns ?? '—', 'num'),
          cell(row.cost_estimate_usd ? row.cost_estimate_usd.toFixed(2) : '—', 'num'),
          cell(row.candidate || '—'),
        ]),
      )
    : '<p class="muted">no runs match the filter</p>';
}

/* --- formatting ---------------------------------------------------------------------- */

function minutesSince(iso) {
  if (!iso) return null;
  const moment = Date.parse(String(iso).replace(' ', 'T'));
  if (Number.isNaN(moment)) return null;
  return Math.max(0, Math.round((Date.now() - moment) / 60000));
}

function humanAge(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days} d ${hours % 24} h`;
  return `${Math.floor(days / 30)} mo`;
}

/* Short times: on a phone a full ISO string pushes out the status, which is what people look for. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortTime(iso) {
  if (!iso) return '—';
  const moment = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(moment.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${MONTHS[moment.getUTCMonth()]} ${moment.getUTCDate()} ${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}`;
}

function shortDate(iso) {
  if (!iso) return '—';
  const moment = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(moment.getTime())) return String(iso);
  return `${MONTHS[moment.getUTCMonth()]} ${moment.getUTCDate()}, ${moment.getUTCFullYear()}`;
}

function compact(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return value.toFixed(2);
}

function shortAddress(address) {
  const a = String(address);
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function badge(status, label) {
  return `<td><span class="badge ${esc(status)}">${esc(label || status)}</span></td>`;
}

function table(headers, rows) {
  const th = (h) => (typeof h === 'object' ? `<th class="${esc(h.cls)}">${esc(h.text)}</th>` : `<th>${esc(h)}</th>`);
  return `<table><thead><tr>${headers.map(th).join('')}</tr></thead><tbody>${rows
    .map((cells) => `<tr>${cells.join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function cell(value, cls = '') {
  return `<td${cls ? ` class="${cls}"` : ''}>${esc(value)}</td>`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/* --- events ------------------------------------------------------------------------- */

document.addEventListener('click', (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.tab) setState({ tab: target.dataset.tab });
  else if (target.dataset.status) setState({ status: target.dataset.status });
  else if (target.dataset.source) setState({ source: target.dataset.source, protocol: 'all', status: 'all' });
  else if (target.dataset.history) setState({ history: target.dataset.history });
});
$('protocol-filter').addEventListener('change', (e) => setState({ protocol: e.target.value, status: 'all' }));
$('search').addEventListener('input', (e) => setState({ q: e.target.value.trim() }));
$('stage-filter').addEventListener('change', (e) => setState({ stage: e.target.value }));
$('result-filter').addEventListener('change', (e) => setState({ result: e.target.value }));
window.addEventListener('hashchange', () => {
  readHash();
  if (snapshot) render(snapshot);
});
$('refresh').addEventListener('click', load);

readHash();
load();
setInterval(load, REFRESH_MS);
