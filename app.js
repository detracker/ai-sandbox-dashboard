/* Дашборд читает снимок, который бокс кладёт в ветку `data` этого же репозитория.
 *
 * Почему raw, а не файл рядом со страницей: у GitHub Pages мягкий лимит 10 сборок в час, а
 * снимок обновляется раз в две минуты. Снимок живёт в отдельной ветке, Pages её не собирает,
 * поэтому пересборок нет вовсе. Плата — кэш raw (до ~5 минут), поэтому возраст снимка
 * показывается в заголовке и не притворяется живым.
 */
const SNAPSHOT = 'https://raw.githubusercontent.com/detracker/ai-sandbox-dashboard/data/snapshot.json';
const SUPPORTED_SCHEMA = 1;
const REFRESH_MS = 60_000;

const $ = (id) => document.getElementById(id);

async function load() {
  try {
    const response = await fetch(`${SNAPSHOT}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    $('age').textContent = 'снимок недоступен';
    $('age').classList.add('stale');
    $('source').textContent = String(error);
  }
}

function render(data) {
  if (data.schema_version !== SUPPORTED_SCHEMA) {
    // Лучше сказать прямо, чем молча показать не то: смысл полей мог измениться.
    $('source').textContent =
      `снимок версии ${data.schema_version}, страница понимает ${SUPPORTED_SCHEMA} — обновите страницу`;
  }
  renderAge(data.generated_at);
  renderAwaiting(data.awaiting || []);
  renderNow(data.now);
  renderQueue(data.queue || []);
  renderTotals(data.totals || {}, data.notes || {});
  renderDoctor(data.doctor);
  renderRuns(data.runs || []);
  $('source').textContent = `снимок от ${data.generated_at}`;
}

function minutesSince(iso) {
  if (!iso) return null;
  const moment = Date.parse(iso.replace(' ', 'T'));
  if (Number.isNaN(moment)) return null;
  return Math.max(0, Math.round((Date.now() - moment) / 60000));
}

function humanAge(minutes) {
  if (minutes === null) return '—';
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч ${minutes % 60} мин`;
  return `${Math.floor(hours / 24)} дн ${hours % 24} ч`;
}

function renderAge(generatedAt) {
  const minutes = minutesSince(generatedAt);
  const node = $('age');
  node.textContent = `снимок: ${humanAge(minutes)} назад`;
  // Больше 15 минут — значит таймер на боксе не сработал, и это надо видеть сразу.
  node.classList.toggle('stale', minutes !== null && minutes > 15);
}

function renderAwaiting(rows) {
  const box = $('awaiting-box');
  box.classList.toggle('hidden', rows.length === 0);
  $('awaiting').innerHTML = rows
    .map((row) => {
      const age = humanAge(row.minutes_in_status);
      const questions = row.open_questions ? `${row.open_questions} вопр.` : '';
      return `<div class="await-row">
        <span class="await-id">${esc(row.id)}</span>
        <span>${esc(row.protocol || '')}</span>
        <span class="muted">${esc(row.chain || '')}</span>
        <span class="await-age">ждёт ${age}</span>
        <span class="muted">вердикт ${esc(row.verdict || '—')}${
          row.findings ? `, замечаний ${row.findings}` : ''
        } ${questions}</span>
      </div>`;
    })
    .join('');
}

function renderNow(now) {
  const node = $('now');
  if (!now) {
    node.className = 'now-empty';
    node.textContent = 'ничего не выполняется';
    return;
  }
  node.className = 'now-line';
  node.innerHTML = `<span class="now-stage">${esc(now.stage)}</span>
    <span>${esc(now.candidate || '—')}</span>
    <span class="muted">идёт ${humanAge(now.minutes)}</span>
    <span class="badge running">running</span>`;
}

function renderQueue(rows) {
  $('queue-count').textContent = rows.length ? `· ${rows.length}` : '· пусто';
  if (!rows.length) {
    $('queue').innerHTML = '<p class="muted">очередь пуста</p>';
    return;
  }
  $('queue').innerHTML = table(
    ['кандидат', 'протокол', 'сеть', 'статус', 'круг', 'в статусе'],
    rows.map((row) => [
      cell(row.id, 'id'),
      cell(row.protocol || '—'),
      cell(row.chain || '—'),
      `<td><span class="badge ${esc(row.status)}">${esc(row.status)}</span></td>`,
      cell(row.round ?? '—', 'num'),
      cell(humanAge(row.minutes_in_status)),
    ]),
  );
}

function renderTotals(totals, notes) {
  const items = [
    ['прогонов', `${totals.runs_today ?? '—'} / ${totals.max_runs_per_day ?? '—'}`],
    ['расход, оценка', `$${(totals.cost_estimate_today_usd ?? 0).toFixed(2)}`],
    ['потолок стадии', `$${(totals.stage_ceiling_usd ?? 0).toFixed(0)}`],
    ['ошибок подряд', totals.consecutive_failures ?? 0],
  ];
  $('totals').innerHTML =
    '<div class="totals">' +
    items
      .map(
        ([label, value]) =>
          `<div><div class="metric-value">${esc(value)}</div><div class="metric-label">${esc(label)}</div></div>`,
      )
      .join('') +
    '</div>';
  $('cost-note').textContent = notes.cost_is_estimate || '';
}

function renderDoctor(doctor) {
  const node = $('doctor');
  if (!doctor || !doctor.checks) {
    node.className = 'chips muted';
    node.textContent = 'нет данных — doctor ещё не запускался';
    return;
  }
  node.className = 'chips';
  node.innerHTML = doctor.checks
    .map((c) => `<span class="chip ${c.ok ? 'ok' : 'fail'}">${esc(c.name)}</span>`)
    .join('');
}

function renderRuns(rows) {
  if (!rows.length) {
    $('runs').innerHTML = '<p class="muted">прогонов ещё не было</p>';
    return;
  }
  $('runs').innerHTML = table(
    ['начало', 'стадия', 'кандидат', 'итог', 'ходов', 'оценка, $'],
    rows.map((row) => [
      cell(row.started_at || '—', 'id'),
      cell(row.stage),
      cell(row.candidate || '—'),
      `<td><span class="badge ${esc(row.status)}">${esc(row.status)}</span></td>`,
      cell(row.turns ?? '—', 'num'),
      cell(row.cost_estimate_usd ? row.cost_estimate_usd.toFixed(2) : '—', 'num'),
    ]),
  );
}

function table(headers, rows) {
  return `<table><thead><tr>${headers
    .map((h) => `<th>${esc(h)}</th>`)
    .join('')}</tr></thead><tbody>${rows
    .map((cells) => `<tr>${cells.join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function cell(value, cls = '') {
  return `<td${cls ? ` class="${cls}"` : ''}>${esc(value)}</td>`;
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

$('refresh').addEventListener('click', load);
load();
setInterval(load, REFRESH_MS);
