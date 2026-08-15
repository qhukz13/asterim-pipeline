#!/usr/bin/env node
// asterim-pipeline CLI:
//   local mode:       init | start | run-once | status | pause | resume | stop
//   distributed mode: orchestrator | worker | workers

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { loadConfig, defaultConfig, PIPELINE_DIR } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { getStatus } from '../src/status.js';
import { readLiveLock, writeControl, acquireLock, releaseLock } from '../src/control.js';
import { readState, writeState } from '../src/store.js';
import { doctor, formatChecks } from '../src/doctor.js';
import { OrchestratorServer } from '../src/server.js';
import { RemoteExecutor } from '../src/remote.js';
import { Worker } from '../src/worker.js';
import { isRepo } from '../src/git.js';

const USAGE = `usage: asterim-pipeline <command> [--root <dir>] [--json]

local mode:
  init          scaffold .pipeline/config.json and the protocol directories
  start         run the pipeline loop in the foreground (Ctrl+C to stop)
  run-once      run a single task cycle, then exit
  status        show pipeline status (--json for machine-readable output)
  doctor        preflight this machine: git, remote, agent commands on PATH;
                add --probe to actually run the agents once and verify they
                can write files headless (the usual cause of stalled runs)
  pause         finish the current agent, then hold before launching the next
  resume        clear pause, or acknowledge a HUMAN_GATE after review
  stop          stop the running pipeline (kills any running agent)

distributed mode (see README "Distributed mode"):
  orchestrator  run the pipeline, dispatching coder/tester to a LAN worker
  worker        run as an execution node: --host <ip> --port <n> --token <t> [--id <name>]
                (or configure .pipeline/worker.json; token also via
                 ASTERIM_PIPELINE_TOKEN or .pipeline/worker.token)
  workers       show registered workers
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = {
    command: '', root: process.cwd(), json: false,
    host: /** @type {string|null} */ (null), port: /** @type {number|null} */ (null),
    token: /** @type {string|null} */ (null), id: /** @type {string|null} */ (null),
    probe: false,
  };
  const rest = [...argv];
  const take = (/** @type {string} */ flag) => {
    const v = rest.shift();
    if (!v) throw new Error(`${flag} requires a value`);
    return v;
  };
  while (rest.length > 0) {
    const a = /** @type {string} */ (rest.shift());
    if (a === '--root') args.root = path.resolve(take(a));
    else if (a === '--json') args.json = true;
    else if (a === '--probe') args.probe = true;
    else if (a === '--host') args.host = take(a);
    else if (a === '--port') args.port = Number(take(a));
    else if (a === '--token') args.token = take(a);
    else if (a === '--id') args.id = take(a);
    else if (a === '--help' || a === '-h') args.command = 'help';
    else if (!args.command) args.command = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (process.env.ASTERIM_PIPELINE_ROOT && args.root === process.cwd() && !argv.includes('--root')) {
    args.root = path.resolve(process.env.ASTERIM_PIPELINE_ROOT);
  }
  return args;
}

const RUNTIME_IGNORES = [
  'state.json', 'state.json.tmp', 'pipeline.log', 'logs/', 'runner.lock', 'worker.lock',
  'control.json', 'workers.json', '*.token', 'worker.json',
];

/** Make sure .pipeline runtime files (including tokens) never reach git. @param {string} root */
function ensurePipelineGitignore(root) {
  const gi = path.join(root, PIPELINE_DIR, '.gitignore');
  fs.mkdirSync(path.dirname(gi), { recursive: true });
  const existing = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/).filter((l) => l.trim() !== ''));
  let changed = false;
  for (const entry of RUNTIME_IGNORES) {
    if (!lines.has(entry)) {
      lines.add(entry);
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(gi, [...lines].join('\n') + '\n', 'utf8');
}

/**
 * Load or create the shared worker token on the orchestrator machine.
 * Stored at .pipeline/orchestrator.token, never committed (gitignored).
 * @param {string} root
 */
function ensureOrchestratorToken(root) {
  const file = path.join(root, PIPELINE_DIR, 'orchestrator.token');
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 16) return token;
  }
  const token = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 });
  console.log(`generated worker token at ${file}`);
  console.log('copy its value to the worker machine (.pipeline/worker.token, ASTERIM_PIPELINE_TOKEN, or --token)');
  return token;
}

/** Resolve the worker-side token: --token > env > .pipeline/worker.token. @param {string} root @param {string|null} flag */
function resolveWorkerToken(root, flag) {
  if (flag) return flag;
  if (process.env.ASTERIM_PIPELINE_TOKEN) return process.env.ASTERIM_PIPELINE_TOKEN;
  const file = path.join(root, PIPELINE_DIR, 'worker.token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return null;
}

/** @param {string} root */
function readWorkerJson(root) {
  const file = path.join(root, PIPELINE_DIR, 'worker.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${/** @type {Error} */ (err).message}`);
  }
}

/** @param {string} root */
function init(root) {
  const dir = path.join(root, PIPELINE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    const d = defaultConfig(root);
    const example = {
      coderCommand: d.agents.coder.command,
      testerCommand: d.agents.tester.command,
      orchestratorCommand: d.agents.orchestrator.command,
      watchDebounceMs: d.watchDebounceMs,
      humanGateOnPhaseComplete: d.humanGateOnPhaseComplete,
      maxConsecutiveTestFailures: d.maxConsecutiveTestFailures,
      skipTestingIfNoTestSpec: d.skipTestingIfNoTestSpec,
      git: d.git,
      remote: { bind: d.remote.bind, port: d.remote.port, heartbeatTimeoutMs: d.remote.heartbeatTimeoutMs },
    };
    fs.writeFileSync(cfgFile, JSON.stringify(example, null, 2) + '\n', 'utf8');
    console.log(`wrote ${cfgFile}`);
  } else {
    console.log(`${cfgFile} already exists; leaving it alone`);
  }
  ensurePipelineGitignore(root);
  const cfg = loadConfig(root);
  for (const rel of Object.values(cfg.files)) {
    fs.mkdirSync(path.dirname(path.resolve(root, rel)), { recursive: true });
  }
  console.log(`initialized pipeline in ${root}`);
  console.log('edit .pipeline/config.json, write your first tasks/current.md, then run: asterim-pipeline start');
}

/**
 * pause/resume/stop: if a runner is live, signal it via the control file;
 * otherwise apply what makes sense directly to state.json.
 * @param {string} root
 * @param {'pause'|'resume'|'stop'} cmd
 */
function control(root, cmd) {
  const live = readLiveLock(root);
  if (live) {
    writeControl(root, cmd);
    console.log(`${cmd} signal sent to running pipeline (pid ${live.pid})`);
    return 0;
  }
  if (cmd === 'stop') {
    console.log('pipeline is not running');
    return 0;
  }
  const { state: s, existed } = readState(root);
  if (cmd === 'pause') {
    s.paused = true;
    writeState(root, s);
    console.log('pipeline is not running; recorded paused=true for the next start');
    return 0;
  }
  // resume, offline
  s.paused = false;
  if (s.state === 'HUMAN_GATE' || s.state === 'FAILED' || s.interrupted) {
    s.state = 'IDLE';
    s.gateReason = null;
    s.interrupted = false;
    console.log('gate acknowledged; next "asterim-pipeline start" will re-evaluate the protocol files');
  } else {
    console.log(existed ? 'pause cleared' : 'nothing to resume');
  }
  writeState(root, s);
  return 0;
}

/** @param {string} root @param {boolean} json */
function workersCmd(root, json) {
  const file = path.join(root, PIPELINE_DIR, 'workers.json');
  if (!fs.existsSync(file)) {
    console.log('no workers have registered (is the orchestrator running?)');
    return 0;
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  const rows = /** @type {any[]} */ (data.workers ?? []);
  const pad = (/** @type {string} */ v, /** @type {number} */ n) => String(v ?? '-').padEnd(n);
  console.log(`${pad('Worker ID', 14)}${pad('Status', 10)}${pad('Agent', 12)}${pad('Task', 12)}Last seen`);
  for (const w of rows) {
    console.log(
      `${pad(w.workerId, 14)}${pad(w.online ? 'ONLINE' : 'OFFLINE', 10)}${pad(w.currentAgent ?? '-', 12)}${pad(w.taskId ?? '-', 12)}${w.lastSeenAt ?? '-'}`,
    );
  }
  return 0;
}

/** @param {ReturnType<typeof parseArgs>} args */
async function orchestratorCmd(args) {
  const config = loadConfig(args.root);
  const root = config.projectRoot;
  const logger = createLogger(root);
  if (!isRepo(root)) {
    console.error('distributed mode requires the project root to be a git repository with a shared remote');
    return 1;
  }
  ensurePipelineGitignore(root);
  const token = ensureOrchestratorToken(root);
  const server = new OrchestratorServer({ root, remoteCfg: config.remote, token, logger });
  const port = await server.listen();
  console.log(`dashboard: http://127.0.0.1:${port}/dashboard`);
  const remote = new RemoteExecutor(server, { root, cfg: config, logger });
  const runner = new Runner({ root, config, logger, remote });
  try {
    const info = await runner.start({});
    return info.gated ? 3 : info.ok ? 0 : 1;
  } finally {
    server.close();
  }
}

/** @param {ReturnType<typeof parseArgs>} args */
async function workerCmd(args) {
  const root = args.root;
  const config = loadConfig(root);
  const wj = readWorkerJson(root);
  const host = args.host ?? (typeof wj.host === 'string' ? wj.host : null);
  const port = args.port ?? (typeof wj.port === 'number' ? wj.port : config.remote.port);
  const workerId = args.id ?? (typeof wj.workerId === 'string' ? wj.workerId : (process.env.COMPUTERNAME || process.env.HOSTNAME || 'worker-01'));
  const token = resolveWorkerToken(root, args.token);
  if (!host) {
    console.error('worker: no orchestrator host configured (use --host or .pipeline/worker.json)');
    return 1;
  }
  if (!token) {
    console.error('worker: no token configured (use --token, ASTERIM_PIPELINE_TOKEN, or .pipeline/worker.token)');
    return 1;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`worker: invalid port ${port}`);
    return 1;
  }
  if (!isRepo(root)) {
    console.error(`worker: ${root} is not a git repository — the worker must run in a local clone of the project`);
    return 1;
  }
  const logger = createLogger(root, { prefix: undefined }); // worker messages carry their own [worker] tag
  acquireLock(root, 'worker');
  const worker = new Worker({
    root, host, port, token, workerId,
    agents: config.agents, files: config.files, logger,
  });
  const onSigint = () => {
    logger.info('[worker] shutting down');
    worker.stop();
  };
  process.on('SIGINT', onSigint);
  try {
    await worker.run();
  } finally {
    process.removeListener('SIGINT', onSigint);
    releaseLock(root, 'worker');
  }
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root;

  switch (args.command) {
    case 'help':
    case '': {
      console.log(USAGE);
      return args.command ? 0 : 1;
    }
    case 'init': {
      init(root);
      return 0;
    }
    case 'start':
    case 'run-once': {
      const config = loadConfig(root);
      const logger = createLogger(config.projectRoot);
      const runner = new Runner({ root: config.projectRoot, config, logger });
      const info = await runner.start({ once: args.command === 'run-once' });
      if (args.command === 'run-once') console.log(info.message);
      return info.gated ? 3 : info.ok ? 0 : 1;
    }
    case 'orchestrator':
      return orchestratorCmd(args);
    case 'worker':
      return workerCmd(args);
    case 'workers':
      return workersCmd(root, args.json);
    case 'doctor': {
      const config = loadConfig(root);
      const logger = createLogger(config.projectRoot, { quiet: true });
      const { checks, ok } = await doctor(config.projectRoot, config, {
        roles: args.probe ? ['coder', 'tester'] : [],
        logger,
      });
      console.log(formatChecks(checks));
      if (!args.probe) console.log('\n(add --probe to verify the agents can write files headless)');
      return ok ? 0 : 1;
    }
    case 'status': {
      const st = getStatus(root);
      console.log(args.json ? JSON.stringify(st.json, null, 2) : st.text);
      return 0;
    }
    case 'pause':
    case 'resume':
    case 'stop':
      return control(root, args.command);
    default: {
      console.error(`unknown command: ${args.command}\n\n${USAGE}`);
      return 1;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);
