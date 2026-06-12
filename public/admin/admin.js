// =====================================================================
// InstaGen — Admin dashboard controller
// =====================================================================
// Talks to /api/admin/usage (GET → snapshot, POST {action:"clear" |
// "test"} → mutates). Renders running totals + a recent-calls log.
// The passcode gate (api/_gate.js) already authenticated this page
// before the static asset handler served it, so the cookie is in
// the jar for the fetch() calls below.
// =====================================================================

import { apiUrl } from '../api-base.js';

const ADMIN_USAGE_ENDPOINT = apiUrl('/api/admin/usage');
const AUTH_LOGOUT_ENDPOINT  = apiUrl('/api/auth/logout');

const $ = (id) => document.getElementById(id);

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const fmtUsd = (n) => {
  const v = Number(n || 0);
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1)    return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
};
const fmtTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false });
};

let toastTimer = null;
function toast(msg, kind = 'ok') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.className = `toast ${kind}`;
  el.textContent = msg;
  // Force a reflow so the transition re-fires.
  void el.offsetWidth;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 2400);
}

async function api(method, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(ADMIN_USAGE_ENDPOINT, opts);
  if (res.status === 401) {
    // The session expired or the cookie was cleared — bounce to
    // the gate, which will redraw the passcode screen.
    window.location.reload();
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

function renderRateCard(rate) {
  const grid = $('rateGrid');
  grid.innerHTML = '';
  const items = [
    { label: 'Text input',  value: `$${rate.inputPerMTok} / 1M tok` },
    { label: 'Text output', value: `$${rate.outputPerMTok} / 1M tok` },
    { label: 'Image',       value: `$${rate.image} / image` },
    { label: 'Video',       value: `$${rate.videoPerSec} / second` },
  ];
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'rate-item';
    el.innerHTML = `
      <span class="rate-item-label">${it.label}</span>
      <span class="rate-item-value">${it.value}</span>
    `;
    grid.appendChild(el);
  }
}

function renderTotals(t) {
  $('statEvents').textContent = fmtInt(t.events);
  const textTotal = (t.textInputTokens || 0) + (t.textOutputTokens || 0);
  $('statText').textContent = fmtInt(textTotal);
  $('statTextSub').textContent =
    `${fmtInt(t.textInputTokens)} in / ${fmtInt(t.textOutputTokens)} out`;
  $('statImages').textContent = fmtInt(t.imageCount);
  $('statVideos').textContent = fmtInt(t.videoCount);
  $('statVideoSub').textContent = t.videoSeconds
    ? `${fmtInt(t.videoSeconds)} seconds`
    : '—';
  $('statUsd').textContent = fmtUsd(t.usd);
}

function renderToday(t, dateKey) {
  $('todayDate').textContent = dateKey || '—';
  $('statTodayEvents').textContent = fmtInt(t.events);
  const textTotal = (t.textInputTokens || 0) + (t.textOutputTokens || 0);
  $('statTodayText').textContent = fmtInt(textTotal);
  $('statTodayTextSub').textContent =
    `${fmtInt(t.textInputTokens)} in / ${fmtInt(t.textOutputTokens)} out`;
  $('statTodayImages').textContent = fmtInt(t.imageCount);
  $('statTodayVideos').textContent = fmtInt(t.videoCount);
  $('statTodayVideoSub').textContent = t.videoSeconds
    ? `${fmtInt(t.videoSeconds)} seconds`
    : '—';
  $('statTodayUsd').textContent = fmtUsd(t.usd);
}

function renderLog(entries) {
  const table = $('logTable');
  const empty = $('logEmpty');
  $('logCount').textContent = String(entries.length);
  if (entries.length === 0) {
    table.innerHTML = '';
    table.appendChild(empty);
    return;
  }
  empty.remove();
  const head = document.createElement('div');
  head.className = 'log-row head';
  head.innerHTML = `
    <div class="cell">Time</div>
    <div class="cell">Route</div>
    <div class="cell">Detail</div>
    <div class="cell">Niche</div>
    <div class="cell">IP</div>
    <div class="cell cost">Cost</div>
  `;
  table.innerHTML = '';
  table.appendChild(head);
  for (const e of entries) {
    const parts = [];
    if (e.textInputTokens || e.textOutputTokens) {
      parts.push(
        `${fmtInt(e.textInputTokens)} in / ${fmtInt(e.textOutputTokens)} out`
      );
    }
    if (e.imageCount) parts.push(`${e.imageCount} img`);
    if (e.videoCount) parts.push(`${e.videoCount} vid × ${e.videoSeconds}s`);
    if (parts.length === 0) parts.push('—');
    const row = document.createElement('div');
    row.className = 'log-row';
    row.innerHTML = `
      <div class="cell time">${fmtTime(e.ts)}</div>
      <div class="cell route">${e.route || '—'}</div>
      <div class="cell nums">${parts.join(' · ')}</div>
      <div class="cell niche">${e.niche || '—'}</div>
      <div class="cell ip">${e.ip || '—'}</div>
      <div class="cell cost">${fmtUsd(e.usd)}</div>
    `;
    table.appendChild(row);
  }
}

async function refresh() {
  try {
    const data = await api('GET');
    if (!data) return;
    renderRateCard(data.snapshot.rateCard);
    renderTotals(data.snapshot.totals);
    renderToday(data.snapshot.total_today, data.snapshot.today_date);
    renderLog(data.snapshot.log);
    $('tgStatusValue').textContent = data.snapshot.totals.events > 0
      ? 'configured'
      : 'configured (no calls yet)';
  } catch (err) {
    toast(`Refresh failed: ${err.message}`, 'error');
  }
}

async function sendTest() {
  $('testBtn').disabled = true;
  try {
    const data = await api('POST', { action: 'test' });
    if (!data) return;
    if (data.result.sent) {
      toast('Test alert sent — check Telegram', 'ok');
    } else {
      toast(`Telegram not configured (${data.result.reason})`, 'error');
    }
  } catch (err) {
    toast(`Test failed: ${err.message}`, 'error');
  } finally {
    $('testBtn').disabled = false;
  }
}

async function clearLog() {
  if (!confirm('Clear the in-memory usage log? This cannot be undone.')) return;
  try {
    await api('POST', { action: 'clear' });
    toast('Log cleared', 'ok');
    await refresh();
  } catch (err) {
    toast(`Clear failed: ${err.message}`, 'error');
  }
}

async function lock() {
  // Wipe the session cookie on the server and bounce to the gate.
  await fetch(AUTH_LOGOUT_ENDPOINT, { method: 'POST', credentials: 'same-origin' });
  window.location.href = '/';
}

$('testBtn').addEventListener('click', sendTest);
$('refreshBtn').addEventListener('click', refresh);
$('clearBtn').addEventListener('click', clearLog);
$('logoutBtn').addEventListener('click', lock);

// First paint + auto-refresh every 5 s so the operator sees new
// calls in near-real-time without hammering the server.
refresh();
setInterval(refresh, 5000);
