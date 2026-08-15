// Integration tests: the runner loop driven by fake agents (small node
// scripts) in an isolated temp project root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Runner } from '../src/runner.js';
import { createLogger } from '../src/logger.js';
import { writeState, defaultState, readState } from '../src/store.js';
import { writeControl } from '../src/control.js';
import { sha256 } from '../src/parse.js';
import {
  makeRoot,
  cleanupRoot,
  write,
  read,
  fakeAgent,
  counter,
  normalCoder,
  normalTester,
  normalOrchestrator,
  testConfig,
  sleep,
} from './helpers.js';

/** @param {() => boolean} cond @param {number} [timeoutMs] */
async function waitFor(cond, timeoutMs = 8000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

/** @param {string} root @param {Parameters<typeof testConfig>[1]} agents */
function makeRunner(root, agents) {
  const config = testConfig(root, agents);
  const logger = createLogger(root, { quiet: true });
  return new Runner({ root, config, logger });
}

function seedTask(root, id = 'T-1') {
  write(root, 'tasks/current.md', `Task-ID: ${id}\nPhase: 1\n\nImplement the thing.\n`);
  write(root, 'test/current.md', `Task-ID: ${id}\nRun the unit tests.\n`);
}

test('happy path: run-once completes coder -> tester -> orchestrator -> next task', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: normalOrchestrator(root),
    });
    const info = await r.start({ once: true });
    assert.equal(info.ok, true, info.message);
    assert.equal(info.gated, false);
    assert.equal(r.st.state, 'TASK_READY');
    assert.equal(r.st.taskId, 'T-2'); // orchestrator issued the next task
    assert.equal(r.st.tasksExecuted, 1);
    assert.equal(r.st.lastCoderStatus, 'COMPLETE');
    assert.equal(r.st.lastTestResult, 'PASS');
    assert.deepEqual([counter(root, 'coder'), counter(root, 'tester'), counter(root, 'orch')], [1, 1, 1]);
    // persisted state survives
    assert.equal(readState(root).state.state, 'TASK_READY');
  } finally {
    cleanupRoot(root);
  }
});

test('malformed coder report leads to HUMAN_GATE', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const badCoder = fakeAgent(
      root,
      'bad-coder',
      `fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'I did some stuff, it went great.\\n');
       process.exit(0);`,
    );
    const r = makeRunner(root, { coder: badCoder });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.equal(r.st.state, 'HUMAN_GATE');
    assert.match(r.st.gateReason ?? '', /missing or malformed/);
    assert.equal(counter(root, 'tester'), 0); // never advanced
  } finally {
    cleanupRoot(root);
  }
});

test('coder that exits without a report leads to HUMAN_GATE (exit code alone is not trusted)', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const r = makeRunner(root, {}); // default fake agents exit 97 with no output
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /code 97/);
  } finally {
    cleanupRoot(root);
  }
});

test('a stale report the coder could not overwrite is never accepted', async () => {
  const root = makeRoot();
  try {
    // The real-world case: the previous task's report is still on disk and
    // the coder cannot write the new one (headless file-write denied).
    seedTask(root, 'T-2');
    write(root, 'reports/current.md', 'Task-ID: T-1\nStatus: COMPLETE\n\nPrevious task, still on disk.\n');
    const mute = fakeAgent(root, 'mute-coder', `bump('coder'); process.exit(0);`);
    const r = makeRunner(root, { coder: mute, tester: normalTester(root, 'PASS') });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.equal(counter(root, 'coder'), 1, 'the coder does run for the new task');
    assert.match(r.st.gateReason ?? '', /was not modified/);
    assert.match(r.st.gateReason ?? '', /previous run/);
    assert.equal(counter(root, 'tester'), 0, 'must not proceed to testing on a stale report');
  } finally {
    cleanupRoot(root);
  }
});

test('a stale test report the tester could not overwrite is never accepted', async () => {
  const root = makeRoot();
  try {
    seedTask(root, 'T-1');
    write(root, 'test/report.md', 'Task-ID: T-1\nResult: PASS\n\nFrom an earlier run.\n');
    const mute = fakeAgent(root, 'mute-tester', `bump('tester'); process.exit(0);`);
    const r = makeRunner(root, { coder: normalCoder(root), tester: mute, orchestrator: normalOrchestrator(root) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /was not modified/);
    assert.equal(counter(root, 'orch'), 0, 'orchestrator must not review a stale test report');
  } finally {
    cleanupRoot(root);
  }
});

test('the freshness check does not false-positive when the coder does write a new report', async () => {
  const root = makeRoot();
  try {
    seedTask(root, 'T-2');
    write(root, 'reports/current.md', 'Task-ID: T-1\nStatus: COMPLETE\n\nPrevious task, still on disk.\n');
    const r = makeRunner(root, {
      coder: normalCoder(root), // overwrites it with a T-2 report
      tester: normalTester(root, 'PASS'),
      orchestrator: normalOrchestrator(root),
    });
    const info = await r.start({ once: true });
    assert.equal(info.gated, false, info.message);
    assert.equal(r.st.lastCoderStatus, 'COMPLETE');
    assert.equal(r.st.lastTestResult, 'PASS');
  } finally {
    cleanupRoot(root);
  }
});

test('coder report for the wrong task leads to HUMAN_GATE', async () => {
  const root = makeRoot();
  try {
    seedTask(root, 'T-1');
    const wrongCoder = fakeAgent(
      root,
      'wrong-coder',
      `fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: T-999\\nStatus: COMPLETE\\n');
       process.exit(0);`,
    );
    const r = makeRunner(root, { coder: wrongCoder });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /T-999.*expected T-1/);
  } finally {
    cleanupRoot(root);
  }
});

test('test failure below threshold goes to orchestrator; repeated failures gate', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const agents = {
      coder: normalCoder(root),
      tester: normalTester(root, 'FAIL'),
      orchestrator: normalOrchestrator(root),
      raw: { maxConsecutiveTestFailures: 2 },
    };
    // Cycle 1: FAIL #1 (< 2) -> orchestrator decides a fix task.
    let info = await makeRunner(root, agents).start({ once: true });
    assert.equal(info.gated, false, info.message);
    const orchPrompt = read(root, '.orch-prompt-1') ?? '';
    assert.match(orchPrompt, /FAILED/);
    assert.equal(readState(root).state.state, 'TASK_READY');
    assert.equal(readState(root).state.consecutiveTestFailures, 1);
    // Cycle 2: FAIL #2 (>= 2) -> human gate.
    const r2 = makeRunner(root, agents);
    info = await r2.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r2.st.gateReason ?? '', /failed 2 times/i);
  } finally {
    cleanupRoot(root);
  }
});

test('blocked coder goes to orchestrator with a blocked trigger', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const blockedCoder = fakeAgent(
      root,
      'blocked-coder',
      `bump('coder');
       fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: ' + readTaskId() + '\\nStatus: BLOCKED\\n');
       process.exit(0);`,
    );
    const r = makeRunner(root, { coder: blockedCoder, orchestrator: normalOrchestrator(root) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, false, info.message);
    assert.equal(counter(root, 'tester'), 0); // testing skipped on BLOCKED
    assert.match(read(root, '.orch-prompt-1') ?? '', /BLOCKED/);
    assert.equal(r.st.state, 'TASK_READY');
  } finally {
    cleanupRoot(root);
  }
});

test('phase completion from the orchestrator gates with a summary', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: normalOrchestrator(root, { phaseAfter: 1 }),
    });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.equal(r.st.state, 'HUMAN_GATE');
    assert.match(r.st.gateReason ?? '', /Phase 1 has completed/);
    assert.equal(r.st.tasksExecuted, 1);
  } finally {
    cleanupRoot(root);
  }
});

test('orchestrator that exits without updating the task file gates', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const lazyOrch = fakeAgent(root, 'lazy-orch', `bump('orch'); process.exit(0);`);
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: lazyOrch,
    });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /without updating tasks\/current.md/);
  } finally {
    cleanupRoot(root);
  }
});

test('recovery: restart after crash mid-CODING gates instead of relaunching', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const s = defaultState();
    s.state = 'CODING';
    s.taskId = 'T-1';
    s.coderPid = null; // crashed; process gone
    writeState(root, s);
    const r = makeRunner(root, { coder: normalCoder(root) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /stopped while coder was running/);
    assert.equal(counter(root, 'coder'), 0, 'coder must NOT be blindly restarted');
  } finally {
    cleanupRoot(root);
  }
});

test('corrupt state file gates instead of guessing', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    write(root, '.pipeline/state.json', '{"state": "CODI'); // torn write
    const r = makeRunner(root, { coder: normalCoder(root) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /corrupt/);
    assert.equal(counter(root, 'coder'), 0);
  } finally {
    cleanupRoot(root);
  }
});

test('IDLE ignores a rewrite with identical content (timestamp-only change)', async () => {
  const root = makeRoot();
  try {
    const content = 'Task-ID: T-1\nPhase: 1\n';
    write(root, 'tasks/current.md', content);
    const r = makeRunner(root, {}); // agents would exit 97 and gate if ever launched
    r.st.hashes.task = sha256(content); // already processed
    const p = r.stepOnce();
    r.wake();
    assert.equal(await p, false);
    assert.equal(r.st.state, 'IDLE'); // no TASK_READY, no launch
  } finally {
    cleanupRoot(root);
  }
});

test('git validation: COMPLETE with no commit and no code changes gates', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    // Coder writes only the report (a protocol file) — no real code changes.
    const coder = fakeAgent(
      root,
      'noop-coder',
      `fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: ' + readTaskId() + '\\nStatus: COMPLETE\\n');
       process.exit(0);`,
    );
    const git = (/** @type {string[]} */ args) => {
      const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
    };
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'seed']);

    const r = makeRunner(root, { coder, raw: { git: { enabled: true, validateCoderCommit: true } } });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /no new commit and no code changes/);
  } finally {
    cleanupRoot(root);
  }
});

test('run-once while paused does not launch agents', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const s = defaultState();
    s.paused = true;
    writeState(root, s);
    const r = makeRunner(root, { coder: normalCoder(root) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, false);
    assert.match(info.message, /paused/);
    assert.equal(counter(root, 'coder'), 0);
  } finally {
    cleanupRoot(root);
  }
});

test('live: watcher-driven cycle, duplicate events, gate hold, stop via control file', async () => {
  const root = makeRoot();
  try {
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: normalOrchestrator(root, { phaseAfter: 1 }),
    });
    const done = r.start(); // continuous mode
    await waitFor(() => r.st.state === 'IDLE');

    // A burst of writes must trigger exactly one coder launch (debounce).
    const taskContent = 'Task-ID: T-1\nPhase: 1\n\nDo it.\n';
    write(root, 'test/current.md', 'Task-ID: T-1\nRun tests.\n');
    for (let i = 0; i < 3; i++) {
      write(root, 'tasks/current.md', taskContent);
      await sleep(20);
    }

    await waitFor(() => r.st.state === 'HUMAN_GATE', 15000); // phase complete after one cycle
    assert.deepEqual([counter(root, 'coder'), counter(root, 'tester'), counter(root, 'orch')], [1, 1, 1]);

    // While gated, file changes must NOT relaunch anything.
    write(root, 'tasks/current.md', read(root, 'tasks/current.md') ?? '');
    await sleep(700);
    assert.equal(counter(root, 'coder'), 1);
    assert.equal(r.st.state, 'HUMAN_GATE');

    writeControl(root, 'stop');
    await done;
    assert.equal(r.st.state, 'HUMAN_GATE'); // gate survives a stop
  } finally {
    cleanupRoot(root);
  }
});

test('rescan resumes mid-cycle from file contents (IDLE state + finished reports on disk)', async () => {
  const root = makeRoot();
  try {
    // Simulates an offline "resume" after a gate: state.json says IDLE but the
    // protocol files show the coder and tester already finished T-1.
    seedTask(root, 'T-1');
    write(root, 'reports/current.md', 'Task-ID: T-1\nStatus: COMPLETE\n');
    write(root, 'test/report.md', 'Task-ID: T-1\nResult: PASS\n');
    writeState(root, defaultState()); // IDLE
    const r = makeRunner(root, { orchestrator: normalOrchestrator(root) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, false, info.message);
    assert.equal(counter(root, 'coder'), 0, 'coder must not re-run a finished task');
    assert.equal(counter(root, 'tester'), 0, 'tester must not re-run');
    assert.equal(counter(root, 'orch'), 1, 'orchestrator picks up from the finished reports');
    assert.equal(r.st.state, 'TASK_READY');
    assert.equal(r.st.taskId, 'T-2');
  } finally {
    cleanupRoot(root);
  }
});

test('live: human gate is not auto-continued; resume re-evaluates and proceeds', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    const s = defaultState();
    s.state = 'HUMAN_GATE';
    s.gateReason = 'test gate';
    writeState(root, s);
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: normalOrchestrator(root, { phaseAfter: 1 }),
    });
    const done = r.start();
    await sleep(700);
    assert.equal(counter(root, 'coder'), 0, 'gate must hold until resume');
    assert.equal(r.st.state, 'HUMAN_GATE');

    writeControl(root, 'resume');
    await waitFor(() => r.st.state === 'HUMAN_GATE' && /Phase 1/.test(r.st.gateReason ?? ''), 15000);
    assert.equal(counter(root, 'coder'), 1); // resumed, ran the cycle once
    writeControl(root, 'stop');
    await done;
  } finally {
    cleanupRoot(root);
  }
});
