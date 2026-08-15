// Read-only pipeline dashboard, served by the orchestrator's existing HTTP
// listener at /dashboard. Loopback-only (the PC's own browser): it needs no
// token, exposes nothing to the LAN, and transports no agent transcripts —
// just state.json, workers.json, and a pipeline.log tail.

import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_DIR } from './config.js';
import { readState } from './store.js';

const LOG_TAIL_LINES = 60;
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * Snapshot for the dashboard's polling endpoint.
 * @param {string} root
 */
export function dashboardData(root) {
  const { state } = readState(root);
  /** @type {any[]} */
  let workers = [];
  try {
    const wf = path.join(root, PIPELINE_DIR, 'workers.json');
    if (fs.existsSync(wf)) workers = JSON.parse(fs.readFileSync(wf, 'utf8')).workers ?? [];
  } catch {
    /* partial data is fine */
  }
  /** @type {string[]} */
  let log = [];
  try {
    const lf = path.join(root, PIPELINE_DIR, 'pipeline.log');
    const size = fs.statSync(lf).size;
    const fd = fs.openSync(lf, 'r');
    try {
      const start = Math.max(0, size - LOG_TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      log = buf.toString('utf8').split(/\r?\n/).filter((l) => l !== '').slice(-LOG_TAIL_LINES);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* no log yet */
  }
  return { now: new Date().toISOString(), state, workers, log };
}

/** The single-page dashboard. Self-contained: no external assets. */
export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>asterim-pipeline</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, Consolas, monospace; background: #14161a; color: #d4d7dd; margin: 0; padding: 1.2rem 1.6rem; }
  h1 { font-size: 1rem; letter-spacing: .08em; color: #8a91a0; margin: 0 0 1rem; text-transform: uppercase; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: .6rem; margin-bottom: 1rem; }
  .card { background: #1c1f26; border: 1px solid #2a2e38; border-radius: 6px; padding: .6rem .8rem; }
  .card .k { font-size: .68rem; color: #8a91a0; text-transform: uppercase; letter-spacing: .06em; }
  .card .v { font-size: 1.05rem; margin-top: .2rem; word-break: break-all; }
  .state-HUMAN_GATE .v, .state-FAILED .v, .state-BLOCKED .v { color: #ff7b72; }
  .state-CODING .v, .state-TESTING .v, .state-ORCHESTRATING .v { color: #d2a8ff; }
  .state-TASK_READY .v, .state-CODE_REPORT_READY .v, .state-TEST_REPORT_READY .v { color: #79c0ff; }
  .state-IDLE .v { color: #7ee787; }
  .gate { background: #3d1d1f; border: 1px solid #6e2c31; border-radius: 6px; padding: .7rem .9rem; margin-bottom: 1rem; color: #ffb4ae; display: none; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .35rem .7rem; border-bottom: 1px solid #2a2e38; font-size: .85rem; }
  th { color: #8a91a0; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em; }
  .online { color: #7ee787; } .offline { color: #ff7b72; }
  pre { background: #101216; border: 1px solid #2a2e38; border-radius: 6px; padding: .8rem; font-size: .78rem; line-height: 1.5; overflow-x: auto; max-height: 45vh; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
  .muted { color: #6b7280; font-size: .75rem; }
</style>
</head>
<body>
<h1>asterim-pipeline &mdash; orchestrator</h1>
<div class="gate" id="gate"></div>
<div class="grid" id="cards"></div>
<table>
  <thead><tr><th>Worker</th><th>Status</th><th>Agent</th><th>Task</th><th>Last seen</th></tr></thead>
  <tbody id="workers"><tr><td colspan="5" class="muted">no workers yet</td></tr></tbody>
</table>
<pre id="log">loading…</pre>
<div class="muted" id="updated"></div>
<script>
function esc(s) { return String(s ?? '-').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function ago(iso) {
  if (!iso) return '-';
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s) || s < 0) return '-';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
}
function card(k, v, cls) { return '<div class="card ' + (cls || '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v) + '</div></div>'; }
async function tick() {
  try {
    const d = await (await fetch('/dashboard/data')).json();
    const st = d.state;
    document.getElementById('cards').innerHTML =
      card('State', st.state + (st.paused ? ' (paused)' : ''), 'state-' + st.state) +
      card('Phase', st.phase) +
      card('Task', st.taskId) +
      card('Task started', ago(st.startedAt)) +
      card('Tasks executed', st.tasksExecuted) +
      card('Last coder status', st.lastCoderStatus) +
      card('Last test result', st.lastTestResult) +
      card('Consecutive test fails', st.consecutiveTestFailures);
    const gate = document.getElementById('gate');
    if (st.gateReason) { gate.style.display = 'block'; gate.textContent = 'HUMAN REVIEW REQUIRED — ' + st.gateReason + '  (run: asterim-pipeline resume)'; }
    else gate.style.display = 'none';
    document.getElementById('workers').innerHTML = d.workers.length
      ? d.workers.map(w => '<tr><td>' + esc(w.workerId) + '</td><td class="' + (w.online ? 'online' : 'offline') + '">' + (w.online ? 'ONLINE' : 'OFFLINE') + '</td><td>' + esc(w.currentAgent) + '</td><td>' + esc(w.taskId) + '</td><td>' + ago(w.lastSeenAt) + '</td></tr>').join('')
      : '<tr><td colspan="5" class="muted">no workers yet</td></tr>';
    const logEl = document.getElementById('log');
    const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
    logEl.textContent = d.log.join('\\n') || '(log empty)';
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('updated').textContent = 'orchestrator unreachable — ' + new Date().toLocaleTimeString();
  }
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>
`;
}
