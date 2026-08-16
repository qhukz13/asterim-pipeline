// Read-only pipeline dashboard, served by the orchestrator's existing HTTP
// listener at /dashboard. Loopback-only (the PC's own browser): it needs no
// token, exposes nothing to the LAN, and shows no agent transcripts — only
// what already lives in the orchestrator's own working copy.

export { dashboardData } from './dashboard-data.js';

/**
 * The single-page dashboard. Self-contained: no external assets.
 * @param {string} [controlToken] authorizes pause/resume/stop from the page;
 *   it is only ever served to loopback, so a cross-origin page cannot read it.
 */
export function dashboardHtml(controlToken = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>asterim-pipeline</title>
<style>
  /* ---- Asterim design tokens ------------------------------------------
     Mirrors apps/web/src/styles/tokens.css: four-tier neutral slate surface
     stack, white-alpha hairline borders, single emerald accent. Fonts are
     named first and fall back to system faces — this page loads no external
     assets, so Inter/JetBrains Mono are used only if installed locally. */
  :root {
    color-scheme: dark;
    --bg: #0b0c0e;          /* surface-0, deep canvas */
    --panel: #121417;       /* surface-1, primary panel */
    --panel-2: #191c20;     /* surface-2, elevated / sub-panel */
    --panel-3: #22262c;     /* surface-3, active / floating */

    --line-subtle: rgba(255,255,255,.06);
    --line: rgba(255,255,255,.12);
    --line-strong: rgba(255,255,255,.20);
    --line-hover: rgba(255,255,255,.28);

    --fg: #f1f5f9;
    --fg-soft: #94a3b8;
    --dim: #64748b;
    --faint: #64748b;

    --accent: #10b981;
    --accent-hover: #34d399;
    --accent-subtle: rgba(16,185,129,.12);
    --accent-glow: rgba(16,185,129,.25);

    --ok: #10b981;      --ok-bg: rgba(16,185,129,.12);
    --warn: #f59e0b;    --warn-bg: rgba(245,158,11,.12);
    --wait: #a855f7;    --wait-bg: rgba(168,85,247,.12);
    --err: #ef4444;     --err-bg: rgba(239,68,68,.12);
    --idle: #94a3b8;    --idle-bg: rgba(148,163,184,.12);

    --radius-sm: 4px;
    --radius: 6px;
    --radius-lg: 8px;

    --ui: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --mono: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', Consolas, monospace;

    --shadow-sm: 0 1px 2px rgba(0,0,0,.35);
    --shadow-md: 0 4px 12px rgba(0,0,0,.45);
    --ease: cubic-bezier(.16, 1, .3, 1);
    --t-fast: 120ms var(--ease);
  }
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--panel-3); border-radius: 4px; }
  html { scrollbar-color: var(--panel-3) transparent; scrollbar-width: thin; }
  body {
    font-family: var(--ui); background: var(--bg); color: var(--fg);
    margin: 0; padding: 0 0 32px; font-size: 15px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    font-feature-settings: 'cv02','cv03','cv04','cv11','tnum';
  }
  .wrap { max-width: 1400px; margin: 0 auto; padding: 0 24px; }
  .eyebrow { font-size: 12px; font-weight: 600; text-transform: uppercase;
             letter-spacing: .06em; color: var(--dim); }

  /* ---- header ---------------------------------------------------------- */
  header {
    position: sticky; top: 0; z-index: 200;
    background: rgba(11,12,14,.88); backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--line-subtle); margin-bottom: 20px;
  }
  .hbar { display: flex; align-items: center; gap: 14px; height: 48px; flex-wrap: wrap; }
  .brand { font-weight: 600; font-size: 15px; letter-spacing: -.01em; }
  .brand span { color: var(--dim); font-weight: 400; }
  .pill {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 3px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .05em;
    color: var(--idle); background: var(--idle-bg); border: 1px solid currentColor;
  }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; flex: none; }
  .pill.busy .dot { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
  /* Asterim state semantics: working = emerald, waiting = violet,
     error/attention = red, nothing to do = slate. */
  .s-CODING, .s-TESTING, .s-ORCHESTRATING { color: var(--ok); background: var(--ok-bg); }
  .s-TASK_READY, .s-CODE_REPORT_READY, .s-TEST_REPORT_READY { color: var(--wait); background: var(--wait-bg); }
  .s-HUMAN_GATE, .s-FAILED, .s-BLOCKED { color: var(--err); background: var(--err-bg); }
  .s-IDLE { color: var(--idle); background: var(--idle-bg); }
  .tl .to.s-CODING, .tl .to.s-TESTING, .tl .to.s-ORCHESTRATING,
  .tl .to.s-TASK_READY, .tl .to.s-CODE_REPORT_READY, .tl .to.s-TEST_REPORT_READY,
  .tl .to.s-HUMAN_GATE, .tl .to.s-FAILED, .tl .to.s-BLOCKED, .tl .to.s-IDLE { background: none; }
  .spacer { margin-left: auto; }
  .rootpath { color: var(--dim); font-size: 12px; font-family: var(--mono); }
  button {
    font: inherit; font-size: 12px; height: 32px; background: transparent; color: var(--fg-soft);
    border: 1px solid var(--line); border-radius: var(--radius); padding: 0 11px; cursor: pointer;
    transition: border-color var(--t-fast), color var(--t-fast), background var(--t-fast);
  }
  button:hover { color: var(--fg); border-color: var(--line-hover); background: var(--panel-2); }
  button:active { transform: scale(.98); }
  .stamp { color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  .ctrls { display: inline-flex; gap: 6px; }
  button.danger:hover { color: var(--err); border-color: rgba(239,68,68,.5); background: var(--err-bg); }
  button.on { color: var(--accent); border-color: var(--accent); background: var(--accent-subtle); }
  button:disabled { opacity: .45; cursor: default; }
  .tabs { display: inline-flex; gap: 4px; margin-left: 12px; }
  button.tab { height: 22px; padding: 0 8px; font-size: 11px; text-transform: none; letter-spacing: 0; }
  .toast { position: fixed; right: 20px; bottom: 20px; z-index: 2000; background: var(--panel-3);
           border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 14px;
           box-shadow: var(--shadow-md); font-size: 13.5px; display: none; }
  /* live output feed */
  #out { max-height: 46vh; }
  .o-role { color: var(--dim); }
  .o-coder { color: var(--accent); }
  .o-tester { color: var(--wait); }
  .o-orchestrator { color: var(--warn); }
  .o-mark { color: var(--fg-soft); font-weight: 600; }
  .o-tool { color: var(--fg); }
  .o-bad { color: var(--err); }
  .o-good { color: var(--ok); }

  /* ---- gate banner ------------------------------------------------------ */
  .gate {
    display: none; gap: 12px; align-items: flex-start;
    background: var(--err-bg); border: 1px solid rgba(239,68,68,.32);
    border-left: 2px solid var(--err);
    border-radius: var(--radius); padding: 14px 16px; margin-bottom: 20px;
  }
  .gate strong { color: var(--err); display: block; font-size: 12px; letter-spacing: .06em;
                 text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
  .gate .why { color: var(--fg); }
  .gate code { font-family: var(--mono); font-size: 13.5px; background: var(--panel-3);
               padding: 1px 6px; border-radius: var(--radius-sm); color: var(--fg); }

  /* ---- stat strip ------------------------------------------------------- */
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 20px; }
  .stat { background: var(--panel); border: 1px solid var(--line-subtle); border-radius: var(--radius);
          padding: 10px 14px; box-shadow: var(--shadow-sm); }
  .stat .k { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
  .stat .v { font-size: 20px; margin-top: 2px; font-weight: 600; letter-spacing: -.01em;
             font-variant-numeric: tabular-nums; word-break: break-word; line-height: 1.25; }
  .stat .v.sm { font-size: 15px; font-weight: 500; }

  /* ---- panels ----------------------------------------------------------- */
  .cols { display: grid; grid-template-columns: 1.7fr 1fr; gap: 16px; margin-bottom: 16px; align-items: start; }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--line-subtle); border-radius: var(--radius);
           box-shadow: var(--shadow-sm); overflow: hidden; }
  .panel > h2 {
    font-size: 12px; letter-spacing: .06em; color: var(--dim); text-transform: uppercase;
    font-weight: 600; margin: 0; padding: 10px 16px; border-bottom: 1px solid var(--line-subtle);
    display: flex; align-items: center;
  }
  .panel .body { padding: 16px; }
  .panel + .panel { margin-top: 16px; }

  .task-title { font-size: 20px; font-weight: 600; letter-spacing: -.015em; line-height: 1.25; margin-bottom: 8px; }
  .task-sum { color: var(--fg-soft); }
  .sub { font-size: 12px; letter-spacing: .06em; color: var(--dim); text-transform: uppercase;
         font-weight: 600; margin: 20px 0 8px; }
  ul.crit { margin: 0; padding: 0; list-style: none; }
  ul.crit li { position: relative; padding: 4px 0 4px 18px; color: var(--fg-soft); }
  ul.crit li::before { content: ''; position: absolute; left: 4px; top: .8em;
                       width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }

  /* ---- collapsibles ------------------------------------------------------ */
  details { border: 1px solid var(--line-subtle); border-radius: var(--radius); margin-top: 8px; background: var(--panel-2); }
  details > summary {
    cursor: pointer; list-style: none; padding: 8px 12px; font-size: 13.5px; color: var(--fg-soft);
    display: flex; align-items: center; gap: 8px; user-select: none; border-radius: var(--radius);
    transition: color var(--t-fast), background var(--t-fast);
  }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: '▸'; color: var(--dim); font-size: 11px; transition: transform var(--t-fast); }
  details[open] > summary::before { transform: rotate(90deg); }
  details > summary:hover { color: var(--fg); background: var(--panel-3); }
  details[open] > summary { border-bottom: 1px solid var(--line-subtle); border-radius: var(--radius) var(--radius) 0 0; }
  details .meta { margin-left: auto; color: var(--dim); font-size: 12px; font-variant-numeric: tabular-nums; }
  details .inner { padding: 12px; }

  pre {
    background: var(--bg); border: 1px solid var(--line-subtle); border-radius: var(--radius-sm);
    padding: 12px 14px; font-family: var(--mono); font-size: 13.5px; line-height: 1.5;
    overflow: auto; max-height: 42vh; white-space: pre-wrap; word-break: break-word; margin: 0;
    font-variant-numeric: tabular-nums;
  }
  #log { max-height: 38vh; }

  /* ---- tables / lists ---------------------------------------------------- */
  /* Wide tables scroll inside their panel rather than widening the page. */
  .tablewrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13.5px; }
  #history td, #history th { white-space: nowrap; }
  th { text-align: left; color: var(--dim); font-size: 12px; text-transform: uppercase;
       letter-spacing: .06em; font-weight: 600; padding: 0 10px 6px 0; }
  td { padding: 6px 10px 6px 0; border-bottom: 1px solid var(--line-subtle);
       color: var(--fg-soft); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .tl { list-style: none; margin: 0; padding: 0; font-size: 13.5px; }
  .tl li { display: flex; align-items: baseline; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line-subtle); }
  .tl li:last-child { border-bottom: none; }
  .tl .to { font-weight: 600; }
  .tl .from { color: var(--dim); font-size: 12px; }
  .tl .dur { margin-left: auto; color: var(--fg-soft); font-variant-numeric: tabular-nums; font-size: 12px; }

  .kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13.5px; margin: 0; }
  .kv dt { color: var(--dim); }
  .kv dd { margin: 0; word-break: break-all; font-family: var(--mono); font-size: 12px; color: var(--fg); }

  .badge { font-size: 12px; font-weight: 600; letter-spacing: .05em; padding: 2px 8px;
           border-radius: var(--radius-sm); text-transform: uppercase; }
  .pass { color: var(--ok); background: var(--ok-bg); }
  .fail { color: var(--err); background: var(--err-bg); }
  .online { color: var(--ok); font-weight: 600; } .offline { color: var(--err); font-weight: 600; }
  .muted { color: var(--dim); font-size: 13.5px; }
  .mono { font-family: var(--mono); color: var(--fg); }

  /* ---- log --------------------------------------------------------------- */
  .lvl-WARN { color: var(--warn); }
  .lvl-ERROR { color: var(--err); }
  .t-orch { color: var(--accent); }
  .t-worker { color: var(--wait); }
  .ts { color: var(--dim); }
</style>
</head>
<body>
<header>
  <div class="wrap hbar">
    <span class="brand">asterim<span>-pipeline</span></span>
    <span class="pill" id="pill"><span class="dot"></span><span id="pill-text">…</span></span>
    <span class="rootpath" id="root"></span>
    <span class="spacer"></span>
    <span class="ctrls">
      <button id="c-pause" title="Finish the running agent, then hold">Pause</button>
      <button id="c-resume" title="Clear a pause, or acknowledge a gate after review">Resume</button>
      <button id="c-stop" class="danger" title="Stop the pipeline (kills a running agent)">Stop</button>
    </span>
    <button id="notify">enable alerts</button>
    <span class="stamp" id="updated"></span>
  </div>
</header>

<div class="wrap">
  <div class="gate" id="gate"></div>
  <div class="stats" id="stats"></div>

  <div class="cols">
    <div>
      <div class="panel">
        <h2>Current task</h2>
        <div class="body" id="task"></div>
      </div>
      <div class="panel">
        <h2>Reports</h2>
        <div class="body" id="reports"></div>
      </div>
    </div>
    <div>
      <div class="panel">
        <h2>Activity</h2>
        <div class="body"><ul class="tl" id="timeline"></ul></div>
      </div>
      <div class="panel">
        <h2>Workers</h2>
        <div class="body" id="workers"></div>
      </div>
      <div class="panel">
        <h2>Repository</h2>
        <div class="body" id="git"></div>
      </div>
      <div class="panel">
        <h2>Configuration</h2>
        <div class="body" id="config"></div>
      </div>
    </div>
  </div>

  <div class="panel">
    <h2>Live agent output
      <span class="tabs" id="out-tabs">
        <button data-role="" class="tab on">all</button>
        <button data-role="coder" class="tab">coder</button>
        <button data-role="tester" class="tab">tester</button>
        <button data-role="orchestrator" class="tab">orchestrator</button>
        <button id="freeze" class="tab">freeze</button>
      </span>
    </h2>
    <div class="body"><pre id="out">waiting for agent output…</pre></div>
  </div>

  <div class="panel">
    <h2>Recent tasks</h2>
    <div class="body" id="history"></div>
  </div>

  <div class="panel">
    <h2>Pipeline log</h2>
    <div class="body"><pre id="log">loading…</pre></div>
  </div>
</div>

<script>
const esc = (s) => String(s ?? '—').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* Open <details> are remembered by key and re-applied after any re-render,
   so the 2s refresh can never collapse something the user opened. */
const openKeys = new Set();
document.addEventListener('toggle', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLDetailsElement) || !el.dataset.key) return;
  if (el.open) openKeys.add(el.dataset.key); else openKeys.delete(el.dataset.key);
}, true); // 'toggle' does not bubble

/* Only touch the DOM when the markup actually changed: keeps scroll
   positions, text selection and focus intact between ticks. */
function setHTML(el, html) {
  if (el.__html === html) return;
  el.__html = html;
  el.innerHTML = html;
  for (const d of el.querySelectorAll('details[data-key]')) d.open = openKeys.has(d.dataset.key);
}

function ago(iso) {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s) || s < 0) return '—';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ago';
  return Math.floor(s / 86400) + 'd ago';
}
function dur(ms) {
  const s = Math.round(ms / 1000);
  if (!isFinite(s) || s < 0) return '';
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}
function bytes(n) {
  if (n == null) return '';
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}
const ACTIVE = ['CODING', 'TESTING', 'ORCHESTRATING'];
const stat = (k, v, cls) => '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div>';

function details(key, summaryHtml, metaHtml, innerHtml) {
  return '<details data-key="' + esc(key) + '"><summary>' + summaryHtml +
    (metaHtml ? '<span class="meta">' + metaHtml + '</span>' : '') +
    '</summary><div class="inner">' + innerHtml + '</div></details>';
}

function renderTask(t) {
  if (!t) return '<div class="muted">No task file yet.</div>';
  let h = '';
  if (t.title) h += '<div class="task-title">' + esc(t.title) + '</div>';
  if (t.summary && t.summary !== t.title) h += '<div class="task-sum">' + esc(t.summary) + '</div>';
  if (t.criteria && t.criteria.length) {
    h += '<div class="sub">Acceptance criteria</div><ul class="crit">' +
      t.criteria.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul>';
  }
  h += details('task-body', 'Full task file', bytes(t.bytes), '<pre>' + esc(t.body) + '</pre>');
  return h;
}

function renderReport(key, label, r, kind) {
  if (!r) return '<div class="muted">' + esc(label) + ' — not written yet.</div>';
  let badge = '';
  if (kind === 'test') {
    const m = /^[ \\t>*_]*result[ \\t]*\\**[ \\t]*[:=][ \\t]*\\**[ \\t]*(pass|fail)/im.exec(r.body || '');
    if (m) badge = ' <span class="badge ' + (/pass/i.test(m[1]) ? 'pass' : 'fail') + '">' + m[1].toUpperCase() + '</span>';
  }
  const gist = r.summary || r.title || '';
  return details(key, '<span>' + esc(label) + '</span>' + badge, bytes(r.bytes),
    (gist ? '<div class="task-sum" style="margin-bottom:.6rem">' + esc(gist) + '</div>' : '') +
    '<pre>' + esc(r.body) + '</pre>');
}

function colorize(line) {
  let cls = '';
  if (line.includes('[ERROR]')) cls = 'lvl-ERROR';
  else if (line.includes('[WARN]')) cls = 'lvl-WARN';
  const h = esc(line)
    .replace(/^(\\S+T\\S+Z)/, '<span class="ts">$1</span>')
    .replace(/\\[orchestrator\\]/g, '<span class="t-orch">[orchestrator]</span>')
    .replace(/\\[worker\\]/g, '<span class="t-worker">[worker]</span>')
    .replace(/\\[(coder|tester)\\]/g, '<span class="t-worker">[$1]</span>');
  return '<span class="' + cls + '">' + h + '</span>';
}

/* ---- controls ---------------------------------------------------------- */
const CONTROL_TOKEN = ${JSON.stringify(controlToken)};
const toast = (() => {
  const el = document.createElement('div');
  el.className = 'toast';
  document.body.appendChild(el);
  let t = null;
  return (msg) => {
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(t);
    t = setTimeout(() => { el.style.display = 'none'; }, 4000);
  };
})();

async function control(action) {
  if (action === 'stop' && !confirm('Stop the pipeline? A running agent will be killed and the task left unfinished.')) return;
  try {
    const r = await fetch('/dashboard/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, controlToken: CONTROL_TOKEN }),
    });
    const body = await r.json().catch(() => ({}));
    toast(r.ok ? action + ' sent to the pipeline' : 'failed: ' + (body.error || r.status));
  } catch (e) {
    toast('control request failed — is the orchestrator still running?');
  }
}
document.getElementById('c-pause').onclick = () => control('pause');
document.getElementById('c-resume').onclick = () => control('resume');
document.getElementById('c-stop').onclick = () => control('stop');

/* ---- live agent output -------------------------------------------------- */
let outCursor = 0, outLines = [], outRole = '', frozen = false;
const OUT_MAX = 1200;
const outEl = document.getElementById('out');

for (const b of document.querySelectorAll('#out-tabs .tab[data-role]')) {
  b.onclick = () => {
    outRole = b.dataset.role;
    for (const o of document.querySelectorAll('#out-tabs .tab[data-role]')) o.classList.toggle('on', o === b);
    renderOutput(true);
  };
}
const freezeBtn = document.getElementById('freeze');
freezeBtn.onclick = () => {
  frozen = !frozen;
  freezeBtn.classList.toggle('on', frozen);
  freezeBtn.textContent = frozen ? 'frozen' : 'freeze';
};

function classifyOutput(text) {
  if (text.startsWith('—')) return 'o-mark';
  if (text.startsWith('▸')) return 'o-tool';
  if (text.startsWith('✗') || text.includes('✗') || text.startsWith('⚠')) return 'o-bad';
  if (text.startsWith('✓')) return 'o-good';
  return '';
}

function renderOutput(force) {
  const shown = outRole ? outLines.filter((l) => l.role === outRole) : outLines;
  const html = shown.length
    ? shown.map((l) => {
        const t = new Date(l.at).toLocaleTimeString();
        return '<span class="ts">' + esc(t) + '</span> <span class="o-role o-' + esc(l.role) + '">' +
          esc(l.role.padEnd(12).slice(0, 12)) + '</span> <span class="' + classifyOutput(l.text) + '">' + esc(l.text) + '</span>';
      }).join('\\n')
    : 'waiting for agent output…';
  if (outEl.__html === html && !force) return;
  const atBottom = outEl.scrollTop + outEl.clientHeight >= outEl.scrollHeight - 20;
  outEl.__html = html;
  outEl.innerHTML = html;
  if (atBottom || force) outEl.scrollTop = outEl.scrollHeight;
}

async function pollOutput() {
  if (frozen) return;
  try {
    const d = await (await fetch('/dashboard/output?since=' + outCursor)).json();
    if (d.dropped) outLines = []; // cursor fell off the ring; resync
    if (d.lines.length) {
      outLines.push(...d.lines);
      if (outLines.length > OUT_MAX) outLines.splice(0, outLines.length - OUT_MAX);
    }
    outCursor = d.cursor;
    if (d.lines.length || d.dropped) renderOutput(false);
  } catch {
    /* the main tick already reports unreachability */
  }
}

let lastGate = null, notifyOn = false;
const notifyBtn = document.getElementById('notify');
notifyBtn.onclick = async () => {
  if (!('Notification' in window)) { notifyBtn.textContent = 'alerts unsupported'; return; }
  notifyOn = (await Notification.requestPermission()) === 'granted';
  notifyBtn.textContent = notifyOn ? 'alerts on' : 'alerts blocked';
};

async function tick() {
  if (frozen) return;
  let d;
  try {
    d = await (await fetch('/dashboard/data')).json();
  } catch {
    document.getElementById('updated').textContent = 'orchestrator unreachable · ' + new Date().toLocaleTimeString();
    return;
  }
  const st = d.state;
  const active = ACTIVE.includes(st.state);

  document.getElementById('root').textContent = d.root;
  const pill = document.getElementById('pill');
  pill.className = 'pill s-' + st.state + (active ? ' busy' : '');
  document.getElementById('pill-text').textContent = st.state + (st.paused ? ' · paused' : '');

  const elapsed = d.stateSince ? dur(Date.now() - Date.parse(d.stateSince)) : '—';
  setHTML(document.getElementById('stats'),
    stat(active ? 'Running for' : 'In state for', esc(elapsed)) +
    stat('Task', esc(st.taskId), 'sm') +
    stat('Phase', esc(st.phase)) +
    stat('Task started', esc(ago(st.startedAt)), 'sm') +
    stat('Tasks executed', esc(st.tasksExecuted)) +
    stat('Coder', esc(st.lastCoderStatus), 'sm') +
    stat('Tests', st.lastTestResult === 'PASS' || st.lastTestResult === 'FAIL'
      ? '<span class="badge ' + (st.lastTestResult === 'PASS' ? 'pass' : 'fail') + '">' + esc(st.lastTestResult) + '</span>'
      : esc(st.lastTestResult), 'sm') +
    stat('Fails in a row', esc(st.consecutiveTestFailures)));

  const gate = document.getElementById('gate');
  if (st.gateReason) {
    gate.style.display = 'flex';
    setHTML(gate, '<div style="flex:1"><strong>Human review required</strong>' +
      '<div class="why">' + esc(st.gateReason) + '</div>' +
      '<div class="muted" style="margin-top:6px">Review the reports, then resume — ' +
      'or run <code>asterim-pipeline resume</code></div>' +
      '<button id="gate-resume" style="margin-top:10px">Resume pipeline</button></div>');
    const gr = document.getElementById('gate-resume');
    if (gr) gr.onclick = () => control('resume');
    if (notifyOn && st.gateReason !== lastGate) {
      new Notification('asterim-pipeline — human review required', { body: st.gateReason });
    }
    lastGate = st.gateReason;
  } else {
    gate.style.display = 'none';
    lastGate = null;
  }

  setHTML(document.getElementById('task'), renderTask(d.task));

  setHTML(document.getElementById('reports'),
    renderReport('rep-coder', 'Coder report', d.coderReport, 'coder') +
    renderReport('rep-test', 'Test report', d.testReport, 'test') +
    renderReport('rep-spec', 'Test spec', d.testSpec, 'spec'));

  const tl = d.transitions.slice().reverse();
  setHTML(document.getElementById('timeline'), tl.length
    ? tl.map((t, i) => {
        const next = tl[i - 1];
        const end = next ? Date.parse(next.at) : Date.now();
        return '<li><span class="to s-' + esc(t.to) + '">' + esc(t.to) + '</span>' +
               '<span class="from">from ' + esc(t.from) + '</span>' +
               '<span class="dur">' + dur(end - Date.parse(t.at)) + '</span></li>';
      }).join('')
    : '<li class="muted">No transitions recorded yet.</li>');

  setHTML(document.getElementById('workers'), d.workers.length
    ? '<div class="tablewrap"><table><thead><tr><th>Worker</th><th>Status</th><th>Agent</th><th>Seen</th></tr></thead><tbody>' +
      d.workers.map((w) => '<tr><td class="mono">' + esc(w.workerId) + '</td>' +
        '<td class="' + (w.online ? 'online' : 'offline') + '">' + (w.online ? 'ONLINE' : 'OFFLINE') + '</td>' +
        '<td>' + esc(w.currentAgent) + '</td><td class="muted">' + ago(w.lastSeenAt) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="muted">No workers registered.</div>');

  setHTML(document.getElementById('git'), d.git
    ? '<dl class="kv"><dt>branch</dt><dd>' + esc(d.git.branch) + '</dd>' +
      '<dt>head</dt><dd>' + esc(d.git.head.sha) + '</dd></dl>' +
      '<div class="task-sum" style="margin-top:.5rem">' + esc(d.git.head.subject) + '</div>' +
      '<div class="muted">' + esc(ago(d.git.head.when)) + ' · ' + esc(d.git.head.author) + '</div>' +
      details('git-recent', 'Recent commits', String(d.git.recent.length),
        '<pre>' + d.git.recent.map((c) => esc(c.sha + '  ' + c.subject)).join('\\n') + '</pre>')
    : '<div class="muted">Not a git repository.</div>');

  const cfg = d.config;
  setHTML(document.getElementById('config'),
    '<dl class="kv">' +
    Object.entries(cfg.agents).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') +
    (cfg.port ? '<dt>port</dt><dd>' + esc(cfg.port) + '</dd>' : '') +
    Object.entries(cfg.files).map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>').join('') +
    '</dl>');

  const hist = Array.isArray(st.history) ? st.history.slice().reverse() : [];
  setHTML(document.getElementById('history'), hist.length
    ? '<div class="tablewrap"><table><thead><tr><th>Task</th><th>Phase</th><th>Coder</th><th>Tests</th>' +
      '<th>Coder</th><th>Tester</th><th>Orch</th><th>Outcome</th></tr></thead><tbody>' +
      hist.map((h) => '<tr>' +
        '<td class="mono">' + esc(h.taskId) + '</td>' +
        '<td>' + esc(h.phase) + '</td>' +
        '<td>' + esc(h.coderStatus) + '</td>' +
        '<td class="' + (h.testResult === 'PASS' ? 'pass' : h.testResult === 'FAIL' ? 'fail' : '') + '">' + esc(h.testResult) + '</td>' +
        '<td>' + esc(h.coderMs ? dur(h.coderMs) : '—') + '</td>' +
        '<td>' + esc(h.testerMs ? dur(h.testerMs) : '—') + '</td>' +
        '<td>' + esc(h.orchestratorMs ? dur(h.orchestratorMs) : '—') + '</td>' +
        '<td class="muted">' + esc(h.outcome) + '</td></tr>').join('') +
      '</tbody></table></div>'
    : '<div class="muted">No completed tasks recorded yet.</div>');

  const logEl = document.getElementById('log');
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 16;
  const logHtml = d.log.map(colorize).join('\\n') || '(log empty)';
  if (logEl.__html !== logHtml) {
    logEl.__html = logHtml;
    logEl.innerHTML = logHtml;
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  document.getElementById('updated').textContent = 'updated ' + new Date().toLocaleTimeString();
}
tick();
pollOutput();
setInterval(tick, 2000);
setInterval(pollOutput, 1000); // output polls faster: it is the "live" bit
</script>
</body>
</html>
`;
}
