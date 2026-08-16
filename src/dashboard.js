// Read-only pipeline dashboard, served by the orchestrator's existing HTTP
// listener at /dashboard. Loopback-only (the PC's own browser): it needs no
// token, exposes nothing to the LAN, and shows no agent transcripts — only
// what already lives in the orchestrator's own working copy.

export { dashboardData } from './dashboard-data.js';

/** The single-page dashboard. Self-contained: no external assets. */
export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>asterim-pipeline</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #14161a; --panel: #1c1f26; --panel2: #101216; --line: #2a2e38;
    --fg: #d4d7dd; --dim: #8a91a0; --faint: #6b7280;
    --green: #7ee787; --red: #ff7b72; --blue: #79c0ff; --purple: #d2a8ff; --amber: #e3b341;
  }
  * { box-sizing: border-box; }
  body { font-family: ui-monospace, Consolas, monospace; background: var(--bg); color: var(--fg);
         margin: 0; padding: 1rem 1.3rem 2rem; font-size: 13px; }
  h1 { font-size: .78rem; letter-spacing: .1em; color: var(--dim); margin: 0; text-transform: uppercase; }
  h2 { font-size: .66rem; letter-spacing: .09em; color: var(--dim); margin: 0 0 .5rem;
       text-transform: uppercase; font-weight: 600; }
  .top { display: flex; align-items: baseline; gap: 1rem; flex-wrap: wrap; margin-bottom: .9rem; }
  .top .root { color: var(--faint); font-size: .72rem; }
  .top .right { margin-left: auto; display: flex; gap: .6rem; align-items: center; }
  button { font: inherit; font-size: .72rem; background: var(--panel); color: var(--dim);
           border: 1px solid var(--line); border-radius: 5px; padding: .25rem .6rem; cursor: pointer; }
  button:hover { color: var(--fg); border-color: var(--dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: .55rem; margin-bottom: .9rem; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .5rem .7rem; }
  .card .k { font-size: .62rem; color: var(--dim); text-transform: uppercase; letter-spacing: .07em; }
  .card .v { font-size: 1rem; margin-top: .15rem; word-break: break-word; }
  .state-HUMAN_GATE .v, .state-FAILED .v, .state-BLOCKED .v { color: var(--red); }
  .state-CODING .v, .state-TESTING .v, .state-ORCHESTRATING .v { color: var(--purple); }
  .state-TASK_READY .v, .state-CODE_REPORT_READY .v, .state-TEST_REPORT_READY .v { color: var(--blue); }
  .state-IDLE .v { color: var(--green); }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%; background: var(--purple);
         margin-right: .35rem; vertical-align: middle; animation: pulse 1.1s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }
  .gate { background: #3d1d1f; border: 1px solid #6e2c31; border-radius: 6px; padding: .65rem .85rem;
          margin-bottom: .9rem; color: #ffb4ae; display: none; }
  .cols { display: grid; grid-template-columns: 1.55fr 1fr; gap: .8rem; margin-bottom: .9rem; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: .7rem .85rem; }
  .task-title { font-size: 1rem; color: var(--fg); margin-bottom: .3rem; }
  .task-sum { color: var(--dim); line-height: 1.5; margin-bottom: .5rem; }
  ul.crit { margin: .2rem 0 0; padding-left: 1.1rem; color: var(--fg); }
  ul.crit li { margin: .18rem 0; line-height: 1.45; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .3rem .6rem .3rem 0; border-bottom: 1px solid var(--line); font-size: .8rem; }
  th { color: var(--dim); font-size: .62rem; text-transform: uppercase; letter-spacing: .07em; }
  tr:last-child td { border-bottom: none; }
  .online { color: var(--green); } .offline { color: var(--red); }
  .tl { list-style: none; margin: 0; padding: 0; font-size: .78rem; }
  .tl li { display: flex; gap: .5rem; padding: .16rem 0; color: var(--dim); }
  .tl .to { color: var(--fg); }
  .tl .dur { margin-left: auto; color: var(--faint); }
  details { margin-top: .55rem; }
  details > summary { cursor: pointer; color: var(--dim); font-size: .72rem; text-transform: uppercase;
                      letter-spacing: .07em; list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: '▸ '; }
  details[open] > summary::before { content: '▾ '; }
  details > summary:hover { color: var(--fg); }
  pre { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px; padding: .7rem;
        font-size: .76rem; line-height: 1.5; overflow-x: auto; max-height: 40vh; overflow-y: auto;
        white-space: pre-wrap; word-break: break-word; margin: .45rem 0 0; }
  #log { max-height: 34vh; }
  .lvl-WARN { color: var(--amber); } .lvl-ERROR { color: var(--red); }
  .tag { color: var(--blue); } .tag-worker { color: var(--purple); }
  .muted { color: var(--faint); font-size: .72rem; }
  .kv { display: grid; grid-template-columns: auto 1fr; gap: .15rem .7rem; font-size: .76rem; }
  .kv dt { color: var(--dim); } .kv dd { margin: 0; color: var(--fg); word-break: break-all; }
  .pass { color: var(--green); } .fail { color: var(--red); }
</style>
</head>
<body>
<div class="top">
  <h1>asterim-pipeline</h1>
  <span class="root" id="root"></span>
  <span class="right">
    <button id="notify">enable alerts</button>
    <span class="muted" id="updated"></span>
  </span>
</div>

<div class="gate" id="gate"></div>
<div class="grid" id="cards"></div>

<div class="cols">
  <div class="panel">
    <h2>Current task</h2>
    <div id="task"><span class="muted">no task file yet</span></div>
  </div>
  <div class="panel">
    <h2>Activity</h2>
    <ul class="tl" id="timeline"></ul>
    <h2 style="margin-top:.8rem">Workers</h2>
    <table><tbody id="workers"></tbody></table>
  </div>
</div>

<div class="cols">
  <div class="panel">
    <h2>Reports</h2>
    <div id="reports"></div>
  </div>
  <div class="panel">
    <h2>Repository</h2>
    <div id="git"><span class="muted">not a git repository</span></div>
    <h2 style="margin-top:.8rem">Configuration</h2>
    <dl class="kv" id="config"></dl>
  </div>
</div>

<div class="panel">
  <h2>Log</h2>
  <pre id="log">loading…</pre>
</div>

<script>
const esc = (s) => String(s ?? '-').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ago(iso) {
  if (!iso) return '-';
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s) || s < 0) return '-';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's ago';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
}
function dur(ms) {
  const s = Math.round(ms / 1000);
  if (!isFinite(s) || s < 0) return '';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
const ACTIVE = ['CODING', 'TESTING', 'ORCHESTRATING'];
const card = (k, v, cls) => '<div class="card ' + (cls || '') + '"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>';

function renderTask(t) {
  if (!t) return '<span class="muted">no task file yet</span>';
  let h = '';
  if (t.title) h += '<div class="task-title">' + esc(t.title) + '</div>';
  if (t.summary && t.summary !== t.title) h += '<div class="task-sum">' + esc(t.summary) + '</div>';
  if (t.criteria && t.criteria.length) {
    h += '<h2 style="margin-top:.6rem">Acceptance criteria</h2><ul class="crit">' +
      t.criteria.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>';
  }
  h += '<details><summary>full task file (' + t.bytes + ' bytes)</summary><pre>' + esc(t.body) + '</pre></details>';
  return h;
}

function renderReport(label, r, kind) {
  if (!r) return '<div class="muted">' + esc(label) + ': not written yet</div>';
  let badge = '';
  if (kind === 'test') {
    const m = /^\\s*result\\s*[:=]\\s*\\**\\s*(pass|fail)/im.exec(r.body) || /(pass|fail)/i.exec(r.summary || '');
    if (m) badge = ' <span class="' + (/pass/i.test(m[1]) ? 'pass' : 'fail') + '">' + m[1].toUpperCase() + '</span>';
  }
  const gist = r.summary || r.title || '';
  return '<details><summary>' + esc(label) + badge + ' — ' + r.bytes + ' bytes</summary>' +
    (gist ? '<div class="task-sum" style="margin-top:.45rem">' + esc(gist) + '</div>' : '') +
    '<pre>' + esc(r.body) + '</pre></details>';
}

function colorize(line) {
  let cls = '';
  if (line.includes('[ERROR]')) cls = 'lvl-ERROR';
  else if (line.includes('[WARN]')) cls = 'lvl-WARN';
  let h = esc(line)
    .replace(/\\[orchestrator\\]/g, '<span class="tag">[orchestrator]</span>')
    .replace(/\\[worker\\]/g, '<span class="tag-worker">[worker]</span>')
    .replace(/\\[(coder|tester)\\]/g, '<span class="tag-worker">[$1]</span>');
  return '<span class="' + cls + '">' + h + '</span>';
}

let lastGate = null, notifyOn = false;
document.getElementById('notify').onclick = async () => {
  if (!('Notification' in window)) return;
  const p = await Notification.requestPermission();
  notifyOn = p === 'granted';
  document.getElementById('notify').textContent = notifyOn ? 'alerts on' : 'alerts blocked';
};

async function tick() {
  let d;
  try {
    d = await (await fetch('/dashboard/data')).json();
  } catch {
    document.getElementById('updated').textContent = 'orchestrator unreachable — ' + new Date().toLocaleTimeString();
    return;
  }
  const st = d.state;
  document.getElementById('root').textContent = d.root;

  const active = ACTIVE.includes(st.state);
  const elapsed = d.stateSince ? dur(Date.now() - Date.parse(d.stateSince)) : '-';
  document.getElementById('cards').innerHTML =
    card('State', (active ? '<span class="dot"></span>' : '') + esc(st.state) + (st.paused ? ' (paused)' : ''), 'state-' + st.state) +
    card(active ? 'Running for' : 'In state for', esc(elapsed)) +
    card('Task', esc(st.taskId) + (st.phase ? ' <span class="muted">phase ' + esc(st.phase) + '</span>' : '')) +
    card('Task started', esc(ago(st.startedAt))) +
    card('Tasks executed', esc(st.tasksExecuted)) +
    card('Last coder status', esc(st.lastCoderStatus)) +
    card('Last test result', '<span class="' + (st.lastTestResult === 'PASS' ? 'pass' : st.lastTestResult === 'FAIL' ? 'fail' : '') + '">' + esc(st.lastTestResult) + '</span>') +
    card('Test failures in a row', esc(st.consecutiveTestFailures));

  const gate = document.getElementById('gate');
  if (st.gateReason) {
    gate.style.display = 'block';
    gate.textContent = 'HUMAN REVIEW REQUIRED — ' + st.gateReason + '   (review, then run: asterim-pipeline resume)';
    if (notifyOn && st.gateReason !== lastGate) new Notification('asterim-pipeline: human review required', { body: st.gateReason });
    lastGate = st.gateReason;
  } else {
    gate.style.display = 'none';
    lastGate = null;
  }

  document.getElementById('task').innerHTML = renderTask(d.task);

  const tl = d.transitions.slice().reverse();
  document.getElementById('timeline').innerHTML = tl.length
    ? tl.map((t, i) => {
        const next = tl[i - 1];
        const end = next ? Date.parse(next.at) : Date.now();
        return '<li><span class="to">' + esc(t.to) + '</span><span>← ' + esc(t.from) + '</span>' +
               '<span class="dur">' + dur(end - Date.parse(t.at)) + '</span></li>';
      }).join('')
    : '<li class="muted">no transitions yet</li>';

  document.getElementById('workers').innerHTML = d.workers.length
    ? d.workers.map((w) => '<tr><td>' + esc(w.workerId) + '</td><td class="' + (w.online ? 'online' : 'offline') + '">' +
        (w.online ? 'ONLINE' : 'OFFLINE') + '</td><td>' + esc(w.currentAgent) + '</td><td class="muted">' + ago(w.lastSeenAt) + '</td></tr>').join('')
    : '<tr><td class="muted">no workers registered</td></tr>';

  document.getElementById('reports').innerHTML =
    renderReport('coder report', d.coderReport, 'coder') +
    renderReport('test report', d.testReport, 'test') +
    renderReport('test spec', d.testSpec, 'spec');

  document.getElementById('git').innerHTML = d.git
    ? '<dl class="kv"><dt>branch</dt><dd>' + esc(d.git.branch) + '</dd>' +
      '<dt>head</dt><dd>' + esc(d.git.head.sha) + ' ' + esc(d.git.head.subject) + '</dd>' +
      '<dt>when</dt><dd>' + esc(ago(d.git.head.when)) + ' by ' + esc(d.git.head.author) + '</dd></dl>' +
      '<details><summary>recent commits</summary><pre>' +
      d.git.recent.map((c) => esc(c.sha + '  ' + c.subject)).join('\\n') + '</pre></details>'
    : '<span class="muted">not a git repository</span>';

  const cfg = d.config;
  document.getElementById('config').innerHTML =
    Object.entries(cfg.agents).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') +
    (cfg.port ? '<dt>port</dt><dd>' + esc(cfg.port) + '</dd>' : '') +
    Object.entries(cfg.files).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('');

  const logEl = document.getElementById('log');
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 12;
  logEl.innerHTML = d.log.map(colorize).join('\\n') || '(log empty)';
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;

  document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>
`;
}
