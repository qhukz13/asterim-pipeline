// Integration tests: the runner loop driven by fake agents (small node
// scripts) in an isolated temp project root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Runner } from '../src/runner.js';
import { DEFAULT_PROMPTS, defaultConfig } from '../src/config.js';
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

test('agent prompts use the configured protocol paths, never hardcoded ones', async () => {
  const root = makeRoot();
  try {
    // A project that uses tests/ (not test/) — the exact drift that made the
    // orchestrator recreate a stray test/current.md every cycle.
    const files = {
      task: 'tasks/current.md',
      coderReport: 'reports/current.md',
      testSpec: 'tests/current.md',
      testReport: 'tests/report.md',
    };
    write(root, files.task, 'Task-ID: T-1\nPhase: 1\n\nDo the thing.\n');
    write(root, files.testSpec, 'Task-ID: T-1\nRun the tests.\n');

    const save = (/** @type {string} */ role, /** @type {string} */ extra) =>
      fakeAgent(root, `p-${role}`, `bump('${role}');
        fs.writeFileSync(path.join(root, '.prompt-${role}'), prompt);
        ${extra}
        process.exit(0);`);
    const coder = save('coder', `fs.mkdirSync(path.join(root, 'reports'), {recursive: true});
      fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: ' + readTaskId() + '\\nStatus: COMPLETE\\n');`);
    const tester = save('tester', `fs.mkdirSync(path.join(root, 'tests'), {recursive: true});
      fs.writeFileSync(path.join(root, 'tests', 'report.md'), 'Task-ID: ' + readTaskId() + '\\nResult: PASS\\n');`);
    const orch = save('orch', `fs.writeFileSync(path.join(root, 'tasks', 'current.md'), 'Status: PHASE_COMPLETE\\nPhase: 1\\n');`);

    const config = testConfig(root, { coder, tester, orchestrator: orch });
    config.files = files; // override the fixtures' pinned defaults
    const r = new Runner({ root, config, logger: createLogger(root, { quiet: true }) });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true); // phase complete
    assert.match(r.st.gateReason ?? '', /Phase 1 has completed/);

    for (const role of ['coder', 'tester', 'orch']) {
      const p = read(root, `.prompt-${role}`) ?? '';
      assert.ok(p !== '', `${role} received no prompt`);
      assert.ok(!/(?:^|[^s])\btest\/(?:current|report)\.md/.test(p), `${role} prompt still names test/: ${p}`);
    }
    assert.match(read(root, '.prompt-tester') ?? '', /tests\/current\.md/);
    assert.match(read(root, '.prompt-tester') ?? '', /tests\/report\.md/);
    assert.match(read(root, '.prompt-orch') ?? '', /tests\/current\.md/);
    assert.match(read(root, '.prompt-orch') ?? '', /tests\/report\.md/);
    assert.match(read(root, '.prompt-coder') ?? '', /tasks\/current\.md/);
    assert.match(read(root, '.prompt-coder') ?? '', /reports\/current\.md/);
  } finally {
    cleanupRoot(root);
  }
});

test('the orchestrator prompt confines it to reviewing and dispatching', () => {
  const p = DEFAULT_PROMPTS.orchestrator;
  // Permissions are pre-approved for this agent, so the prompt is the only
  // thing keeping it out of the code and the test suite.
  assert.match(p, /Do NOT write, edit, refactor, or delete any source/);
  assert.match(p, /Do NOT run tests, builds, linters/);
  assert.match(p, /Do NOT commit, push/);
  assert.match(p, /ONLY files you may create or modify are \{taskFile\} and \{testSpecFile\}/);
  assert.match(p, /read-only git/i);
  assert.match(p, /ONE session/);
});

test('the orchestrator is launched in print mode with the prompt as -p\'s value', () => {
  const { args, promptVia } = defaultConfig('/x').agents.orchestrator;
  // agy's -p consumes the NEXT argument as the prompt, so it must be last
  // and the prompt must be passed as an argument (not piped on stdin) —
  // otherwise -p swallows the following flag and runs that as the prompt.
  assert.equal(promptVia, 'arg');
  assert.equal(args.at(-1), '-p');
  assert.ok(args.includes('--dangerously-skip-permissions'));
});

/** Run one full cycle and return the prompt the orchestrator received. */
async function capturedOrchestratorPrompt(root, roadmap) {
  seedTask(root, 'T-1');
  const orch = fakeAgent(root, 'road-orch', `bump('orch');
    fs.writeFileSync(path.join(root, '.orch-prompt'), prompt);
    fs.writeFileSync(path.join(root, 'tasks', 'current.md'), 'Status: PHASE_COMPLETE\\nPhase: 1\\n');
    process.exit(0);`);
  const config = testConfig(root, { coder: normalCoder(root), tester: normalTester(root, 'PASS'), orchestrator: orch });
  if (roadmap) {
    write(root, roadmap, '# Plan\n\n## 3. Legacy\n## 4. Initiatives\n## 5. Phases 7-10\n');
    config.files.roadmap = roadmap;
  }
  await new Runner({ root, config, logger: createLogger(root, { quiet: true }) }).start({ once: true });
  return read(root, '.orch-prompt') ?? '';
}

test('no roadmap configured leaves the orchestrator prompt unchanged', async () => {
  const root = makeRoot();
  try {
    const p = await capturedOrchestratorPrompt(root, null);
    assert.ok(p !== '', 'the orchestrator should have run');
    assert.ok(!p.includes('ROADMAP-DRIVEN PLANNING'));
  } finally {
    cleanupRoot(root);
  }
});

test('a configured roadmap appends the planning discipline to the prompt', async () => {
  const root = makeRoot();
  try {
    const p = await capturedOrchestratorPrompt(root, 'blueprint/ROADMAP.md');
    assert.match(p, /ROADMAP-DRIVEN PLANNING/);
    assert.match(p, /Read blueprint\/ROADMAP\.md before deciding anything/);
    assert.match(p, /earliest section that is not yet finished/);
    assert.match(p, /PR-sized tasks/);
    assert.match(p, /Dispatch exactly ONE/);
    assert.match(p, /SECTION BOUNDARIES/);
    assert.ok(!p.includes('{roadmapFile}'), 'placeholder must be substituted');
  } finally {
    cleanupRoot(root);
  }
});

test('resuming a phase gate asks the orchestrator to plan the next section', async () => {
  const root = makeRoot();
  try {
    // State as it is right after a phase-complete gate: the task file holds
    // PHASE_COMPLETE and there is nothing for the coder to do.
    write(root, 'tasks/current.md', 'Status: PHASE_COMPLETE\nPhase: 6\n');
    write(root, 'blueprint/ROADMAP.md', '# Plan\n## 3. Legacy\n');
    const s = defaultState();
    s.state = 'HUMAN_GATE';
    s.gateReason = 'Phase 6 has completed.';
    s.phase = '6';
    writeState(root, s);

    const planner = fakeAgent(root, 'planner', `const n = bump('orch');
      fs.writeFileSync(path.join(root, '.plan-prompt'), prompt);
      fs.writeFileSync(path.join(root, 'tasks', 'current.md'), 'Task-ID: P7-01\\nPhase: 7\\n\\nFirst PR of the next section.\\n');
      process.exit(0);`);
    const config = testConfig(root, { coder: normalCoder(root), tester: normalTester(root, 'PASS'), orchestrator: planner });
    config.files.roadmap = 'blueprint/ROADMAP.md';
    const r = new Runner({ root, config, logger: createLogger(root, { quiet: true }) });

    const done = r.start();
    await waitFor(() => r.st.state === 'HUMAN_GATE', 5000);
    assert.equal(counter(root, 'orch'), 0, 'the gate must hold until the human resumes');

    writeControl(root, 'resume');
    await waitFor(() => r.st.taskId === 'P7-01', 15000);
    assert.equal(counter(root, 'orch'), 1, 'resume should trigger exactly one planning run');
    assert.match(read(root, '.plan-prompt') ?? '', /ROADMAP-DRIVEN PLANNING/);
    assert.match(read(root, '.plan-prompt') ?? '', /reviewed and approved by the human/);

    r.requestStop('test done');
    await done;
  } finally {
    cleanupRoot(root);
  }
});

test('re-declaring PHASE_COMPLETE while planning gates instead of looping', async () => {
  const root = makeRoot();
  try {
    // The real failure: asked to plan the next unit, the orchestrator simply
    // restated the marker the human had just cleared. Without a guard that
    // bounces between gate and resume forever.
    write(root, 'tasks/current.md', 'Status: PHASE_COMPLETE\nPhase: 10\n');
    write(root, 'blueprint/ROADMAP.md', '# Plan\n## 3. Legacy\n');
    const s = defaultState();
    s.state = 'HUMAN_GATE';
    s.gateReason = 'Phase 10 has completed.';
    writeState(root, s);

    const stubborn = fakeAgent(root, 'stubborn-orch', `bump('orch');
      fs.writeFileSync(path.join(root, 'tasks', 'current.md'), 'Status: PHASE_COMPLETE\\nPhase: 10\\n\\nStill done.\\n');
      process.exit(0);`);
    const config = testConfig(root, { orchestrator: stubborn });
    config.files.roadmap = 'blueprint/ROADMAP.md';
    const r = new Runner({ root, config, logger: createLogger(root, { quiet: true }) });

    const done = r.start();
    await waitFor(() => r.st.state === 'HUMAN_GATE', 5000);
    writeControl(root, 'resume');
    await waitFor(() => /instead of planning the next unit/.test(r.st.gateReason ?? ''), 15000);
    assert.equal(counter(root, 'orch'), 1, 'must not retry in a loop');

    r.requestStop('test done');
    await done;
  } finally {
    cleanupRoot(root);
  }
});

test('planNextOnResume=false keeps the old hand-written-task behaviour', async () => {
  const root = makeRoot();
  try {
    write(root, 'tasks/current.md', 'Status: PHASE_COMPLETE\nPhase: 6\n');
    const s = defaultState();
    s.state = 'HUMAN_GATE';
    s.gateReason = 'Phase 6 has completed.';
    writeState(root, s);

    const orch = fakeAgent(root, 'never-orch', `bump('orch'); process.exit(0);`);
    const config = testConfig(root, { orchestrator: orch });
    config.planNextOnResume = false;
    const r = new Runner({ root, config, logger: createLogger(root, { quiet: true }) });

    const done = r.start();
    await waitFor(() => r.st.state === 'HUMAN_GATE', 5000);
    writeControl(root, 'resume');
    await sleep(1200);
    assert.equal(counter(root, 'orch'), 0, 'must wait for a hand-written task instead');
    assert.equal(r.st.state, 'IDLE');
    r.requestStop('test done');
    await done;
  } finally {
    cleanupRoot(root);
  }
});

test('default prompts contain no hardcoded protocol paths', () => {
  for (const [role, text] of Object.entries(DEFAULT_PROMPTS)) {
    const hardcoded = text.match(/\b(?:tasks?|reports?|tests?)\/[\w-]+\.md\b/g);
    assert.equal(hardcoded, null, `${role} prompt hardcodes ${hardcoded?.join(', ')}`);
    assert.match(text, /\{\w+File\}/, `${role} prompt should reference a {…File} placeholder`);
  }
});

test('task history records each attempt with per-step timings', async () => {
  const root = makeRoot();
  try {
    seedTask(root, 'T-1');
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: normalOrchestrator(root),
    });
    await r.start({ once: true });

    const { history } = readState(root).state;
    assert.equal(history.length, 1);
    const [h] = history;
    assert.equal(h.taskId, 'T-1');
    assert.equal(h.phase, '1');
    assert.equal(h.coderStatus, 'COMPLETE');
    assert.equal(h.testResult, 'PASS');
    assert.equal(h.outcome, 'advanced');
    assert.ok(h.coderMs > 0 && h.testerMs > 0 && h.orchestratorMs > 0, 'each step should be timed');
    assert.ok(h.endedAt >= h.startedAt);
  } finally {
    cleanupRoot(root);
  }
});

test('a gated attempt is recorded once, not duplicated per gate', async () => {
  const root = makeRoot();
  try {
    seedTask(root, 'T-1');
    const badCoder = fakeAgent(root, 'bad-coder', `bump('coder');
      fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'no fields here\\n');
      process.exit(0);`);
    const r = makeRunner(root, { coder: badCoder });
    await r.start({ once: true });

    let { history } = readState(root).state;
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, 'gated');
    assert.equal(history[0].taskId, 'T-1');

    // Re-running the same attempt updates the row instead of appending.
    const r2 = makeRunner(root, { coder: badCoder });
    await r2.start({ once: true });
    ({ history } = readState(root).state);
    assert.equal(history.length, 1, 'same attempt must stay one row');
  } finally {
    cleanupRoot(root);
  }
});

test('history is capped and survives a state file without it', async () => {
  const root = makeRoot();
  try {
    const s = defaultState();
    // A state.json written by an older version has no history/timings.
    delete (/** @type {any} */ (s).history);
    delete (/** @type {any} */ (s).timings);
    writeState(root, s);
    const back = readState(root);
    assert.equal(back.corrupt, false);
    assert.deepEqual(back.state.history, []);
    assert.equal(back.state.timings.coderMs, 0);
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

test('orchestrator that exits without updating the task file gates, quoting what it said', async () => {
  const root = makeRoot();
  try {
    seedTask(root);
    // Mirrors the real failure: agy prints a permission complaint, writes
    // nothing, and exits 0.
    const lazyOrch = fakeAgent(
      root,
      'lazy-orch',
      `bump('orch');
       console.log('no output produced — a tool required the "command" permission');
       process.exit(0);`,
    );
    const r = makeRunner(root, {
      coder: normalCoder(root),
      tester: normalTester(root, 'PASS'),
      orchestrator: lazyOrch,
    });
    const info = await r.start({ once: true });
    assert.equal(info.gated, true);
    assert.match(r.st.gateReason ?? '', /without updating tasks\/current.md/);
    // The human gate must carry the agent's own words, not just the symptom.
    const log = read(root, '.pipeline/pipeline.log') ?? '';
    assert.match(log, /Last output from the agent/);
    assert.match(log, /required the "command" permission/);
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
