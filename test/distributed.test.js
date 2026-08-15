// Distributed-mode integration tests.
//
// Fixture: a bare git origin + an orchestrator clone + a worker clone.
// The orchestrator (server + Runner) runs in this test process; the worker
// runs as a REAL separate process (the actual CLI) talking to it over
// 127.0.0.1 — repository content moves only through git, results only
// through the LAN protocol.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/runner.js';
import { OrchestratorServer } from '../src/server.js';
import { RemoteExecutor } from '../src/remote.js';
import { createLogger } from '../src/logger.js';
import { mergeConfig } from '../src/config.js';
import { readState, writeState, defaultState } from '../src/store.js';
import { makeGitPair, gitRun, write, read, counter, waitFor, sleep, fakeAgent } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'asterim-pipeline.js');
const TOKEN = 'integration-token-0123456789abcdef';

/** Fast timings so tests stay quick but not flaky. */
const REMOTE = {
  bind: '127.0.0.1', port: 0, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 2500,
  pollTimeoutMs: 250, redeliverMs: 100, dispatchGraceMinutes: 1,
};

/** Fake coder for the WORKER clone: writes code + report, commits (worker pushes). @param {string} root @param {{sleepMs?: number}} [opts] */
function workerCoder(root, opts = {}) {
  return fakeAgent(
    root,
    'wcoder',
    `bump('coder');
     const cp = require('child_process');
     setTimeout(() => {
       const id = readTaskId();
       fs.mkdirSync(path.join(root, 'src'), { recursive: true });
       fs.writeFileSync(path.join(root, 'src', 'feature-' + id + '.txt'), 'implemented ' + id + '\\n');
       fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: ' + id + '\\nStatus: COMPLETE\\n\\nDone on the worker.\\n');
       cp.execSync('git add -A', { cwd: root });
       cp.execSync('git commit -q -m "task ' + id + '"', { cwd: root });
       process.exit(0);
     }, ${opts.sleepMs ?? 0});`,
  );
}

/** Fake tester for the WORKER clone: writes PASS report, commits nothing. @param {string} root */
function workerTester(root) {
  return fakeAgent(
    root,
    'wtester',
    `bump('tester');
     fs.writeFileSync(path.join(root, 'test', 'report.md'), 'Task-ID: ' + readTaskId() + '\\nResult: PASS\\n\\n12/12 tests green (worker).\\n');
     process.exit(0);`,
  );
}

/** Write the worker clone's local agent config. @param {string} root @param {string} coder @param {string} tester */
function writeWorkerConfig(root, coder, tester) {
  write(root, '.pipeline/config.json', JSON.stringify({
    agents: {
      coder: { command: process.execPath, args: [coder], timeoutMinutes: 1 },
      tester: { command: process.execPath, args: [tester], timeoutMinutes: 1 },
    },
  }));
}

/** Spawn the real worker CLI process. @param {string} root @param {number} port */
function spawnWorker(root, port) {
  const child = spawn(process.execPath, [BIN, 'worker', '--root', root, '--host', '127.0.0.1', '--port', String(port), '--token', TOKEN, '--id', 'laptop-01'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  return { child, output: () => output };
}

/** @param {string} orchRoot @param {Record<string, any>} [extraCfg] */
function orchestratorPieces(orchRoot, extraCfg = {}) {
  const config = mergeConfig(orchRoot, {
    git: { enabled: true },
    remote: REMOTE,
    agents: { orchestrator: { command: process.execPath, args: [fakeAgent(orchRoot, 'orch', `
      const n = bump('orch');
      fs.writeFileSync(path.join(root, '.orch-prompt-' + n), prompt);
      fs.writeFileSync(path.join(root, 'tasks', 'current.md'), 'Task-ID: T-' + (n + 1) + '\\nPhase: 1\\n');
      fs.writeFileSync(path.join(root, 'test', 'current.md'), 'Task-ID: T-' + (n + 1) + '\\nRun tests.\\n');
      process.exit(0);`)], timeoutMinutes: 1 } },
    ...extraCfg,
  });
  const logger = createLogger(orchRoot, { quiet: true });
  const server = new OrchestratorServer({ root: orchRoot, remoteCfg: config.remote, token: TOKEN, logger });
  const remote = new RemoteExecutor(server, { root: orchRoot, cfg: config, logger });
  const runner = new Runner({ root: orchRoot, config, logger, remote });
  return { config, logger, server, remote, runner };
}

test('distributed: full cycle over 127.0.0.1 — dispatch, git sync, results, duplicate-safe', async () => {
  const { orchRoot, workerRoot, cleanup } = makeGitPair();
  /** @type {import('node:child_process').ChildProcess|null} */
  let workerChild = null;
  const { server, runner } = orchestratorPieces(orchRoot);
  try {
    // slow-ish coder so several poll cycles (and redeliveries) happen mid-run
    writeWorkerConfig(workerRoot, workerCoder(workerRoot, { sleepMs: 800 }), workerTester(workerRoot));
    const port = await server.listen();
    const w = spawnWorker(workerRoot, port);
    workerChild = w.child;
    await waitFor(() => server.online(), 10000);

    // Antigravity (or the human) wrote the first task on the PC, uncommitted.
    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n\nBuild the feature.\n');
    write(orchRoot, 'test/current.md', 'Task-ID: T-1\nRun tests.\n');

    const info = await runner.start({ once: true });
    assert.equal(info.gated, false, `${info.message} | worker: ${w.output()}`);
    assert.equal(runner.st.state, 'TASK_READY');
    assert.equal(runner.st.taskId, 'T-2'); // local orchestrator issued the next task
    assert.equal(runner.st.tasksExecuted, 1);
    assert.equal(runner.st.lastCoderStatus, 'COMPLETE');
    assert.equal(runner.st.lastTestResult, 'PASS');

    // duplicate deliveries during the 800ms run must not double-launch
    assert.equal(counter(workerRoot, 'coder'), 1, 'coder ran exactly once');
    assert.equal(counter(workerRoot, 'tester'), 1, 'tester ran exactly once');

    // repository content moved through git: the coder's commit + source file arrived by pull
    assert.match(gitRun(orchRoot, ['log', '--oneline']), /task T-1/);
    assert.equal((read(orchRoot, 'src/feature-T-1.txt') ?? '').replace(/\r\n/g, '\n'), 'implemented T-1\n');
    // reports propagated (coder report via git+LAN, tester report via LAN only)
    assert.match(read(orchRoot, 'reports/current.md') ?? '', /Status: COMPLETE/);
    assert.match(read(orchRoot, 'test/report.md') ?? '', /Result: PASS/);
    // the task files were published to the remote before dispatch
    assert.match(gitRun(orchRoot, ['log', '--oneline']), /pipeline: dispatch task T-1/);
  } finally {
    workerChild?.kill();
    server.close();
    cleanup();
  }
});

test('distributed: non-fast-forward on the worker returns WORKER_GIT_CONFLICT and gates', async () => {
  const { orchRoot, workerRoot, cleanup } = makeGitPair();
  /** @type {import('node:child_process').ChildProcess|null} */
  let workerChild = null;
  const { server, runner } = orchestratorPieces(orchRoot);
  try {
    writeWorkerConfig(workerRoot, workerCoder(workerRoot), workerTester(workerRoot));
    // Diverge the worker clone: a local commit origin never saw.
    write(workerRoot, 'local-divergence.txt', 'oops\n');
    gitRun(workerRoot, ['add', '-A']);
    gitRun(workerRoot, ['commit', '-q', '-m', 'divergent local work']);

    const port = await server.listen();
    const w = spawnWorker(workerRoot, port);
    workerChild = w.child;
    await waitFor(() => server.online(), 10000);

    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n');
    write(orchRoot, 'test/current.md', 'Task-ID: T-1\nRun tests.\n');

    const info = await runner.start({ once: true });
    assert.equal(info.gated, true);
    assert.equal(runner.st.state, 'HUMAN_GATE');
    assert.match(runner.st.gateReason ?? '', /WORKER_GIT_CONFLICT/);
    assert.equal(counter(workerRoot, 'coder'), 0, 'coder must not run on a conflicted clone');
  } finally {
    workerChild?.kill();
    server.close();
    cleanup();
  }
});

test('distributed: worker crash mid-task -> WORKER OFFLINE -> HUMAN_GATE; restart preserves the gate', async () => {
  const { orchRoot, workerRoot, cleanup } = makeGitPair();
  /** @type {import('node:child_process').ChildProcess|null} */
  let workerChild = null;
  const { server, runner } = orchestratorPieces(orchRoot, {
    remote: { ...REMOTE, heartbeatTimeoutMs: 800 },
  });
  try {
    writeWorkerConfig(workerRoot, workerCoder(workerRoot, { sleepMs: 20000 }), workerTester(workerRoot));
    const port = await server.listen();
    const w = spawnWorker(workerRoot, port);
    workerChild = w.child;
    await waitFor(() => server.online(), 10000);

    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n');
    write(orchRoot, 'test/current.md', 'Task-ID: T-1\nRun tests.\n');

    const done = runner.start({ once: true });
    await waitFor(() => server.workersInfo()[0]?.currentAgent === 'coder', 10000);
    workerChild.kill(); // hard crash while the coder is running
    const info = await done;
    assert.equal(info.gated, true);
    assert.equal(runner.st.state, 'HUMAN_GATE');
    assert.match(runner.st.gateReason ?? '', /offline/i);
    assert.equal(runner.st.taskId, 'T-1');

    // Orchestrator restart: the gate is authoritative, nothing auto-continues.
    const again = new Runner({
      root: orchRoot,
      config: orchestratorPieces(orchRoot).config,
      logger: createLogger(orchRoot, { quiet: true }),
    });
    const info2 = await again.start({ once: true });
    assert.equal(info2.gated, true);
    assert.match(again.st.gateReason ?? '', /offline/i);
  } finally {
    workerChild?.kill();
    server.close();
    cleanup();
  }
});

test('distributed: run-once with no worker online reports instead of dispatching', async () => {
  const { orchRoot, cleanup } = makeGitPair();
  const { server, runner } = orchestratorPieces(orchRoot);
  try {
    await server.listen();
    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n');
    const info = await runner.start({ once: true });
    assert.equal(info.ok, false);
    assert.match(info.message, /no worker online/);
    assert.equal(runner.st.state, 'TASK_READY'); // nothing was launched or lost
  } finally {
    server.close();
    cleanup();
  }
});

test('distributed: worker reconnects after orchestrator restart and completes a cycle', async () => {
  const { orchRoot, workerRoot, cleanup } = makeGitPair();
  /** @type {import('node:child_process').ChildProcess|null} */
  let workerChild = null;
  const first = orchestratorPieces(orchRoot);
  try {
    writeWorkerConfig(workerRoot, workerCoder(workerRoot), workerTester(workerRoot));
    const port = await first.server.listen();
    const w = spawnWorker(workerRoot, port);
    workerChild = w.child;
    await waitFor(() => first.server.online(), 10000);

    // Orchestrator goes away (server closes); the worker must survive and re-register.
    first.server.close();
    await sleep(600);

    const second = orchestratorPieces(orchRoot, { remote: { ...REMOTE, port } });
    await second.server.listen();
    await waitFor(() => second.server.online(), 15000); // worker reconnected on its own

    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n');
    write(orchRoot, 'test/current.md', 'Task-ID: T-1\nRun tests.\n');
    const info = await second.runner.start({ once: true });
    assert.equal(info.gated, false, `${info.message} | worker: ${w.output()}`);
    assert.equal(second.runner.st.lastTestResult, 'PASS');
    second.server.close();
  } finally {
    workerChild?.kill();
    cleanup();
  }
});

test('distributed: HUMAN_GATE state is never auto-resumed even with a healthy worker online', async () => {
  const { orchRoot, workerRoot, cleanup } = makeGitPair();
  /** @type {import('node:child_process').ChildProcess|null} */
  let workerChild = null;
  const { server, runner } = orchestratorPieces(orchRoot);
  try {
    writeWorkerConfig(workerRoot, workerCoder(workerRoot), workerTester(workerRoot));
    const s = defaultState();
    s.state = 'HUMAN_GATE';
    s.gateReason = 'phase review pending';
    writeState(orchRoot, s);
    const port = await server.listen();
    const w = spawnWorker(workerRoot, port);
    workerChild = w.child;
    await waitFor(() => server.online(), 10000);
    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n');

    const info = await runner.start({ once: true });
    assert.equal(info.gated, true);
    assert.equal(counter(workerRoot, 'coder'), 0, 'nothing may be dispatched while gated');
    assert.equal(readState(orchRoot).state.state, 'HUMAN_GATE');
  } finally {
    workerChild?.kill();
    server.close();
    cleanup();
  }
});
