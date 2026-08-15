import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../src/doctor.js';
import { mergeConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { makeRoot, cleanupRoot, write, fakeAgent, gitRun } from './helpers.js';

/** @param {import('../src/doctor.js').Check[]} checks @param {string} label */
function find(checks, label) {
  const c = checks.find((x) => x.label.includes(label));
  assert.ok(c, `no check matching "${label}"`);
  return c;
}

test('doctor flags a protocol file configured in the wrong directory', async () => {
  const root = makeRoot();
  try {
    // The real-world trap: the repo uses tests/, the config says test/.
    write(root, 'tests/report.md', 'Task-ID: P6-06\nResult: PASS\n');
    write(root, 'tasks/current.md', 'Task-ID: P6-06\n');
    const cfg = mergeConfig(root, {});
    const { checks, ok } = await doctor(root, cfg, { logger: createLogger(root, { quiet: true }) });
    const c = find(checks, 'protocol file (testReport)');
    assert.equal(c.ok, false);
    assert.match(c.detail, /tests\/report\.md does/);
    assert.match(c.detail, /files\.testReport/);
    assert.equal(ok, false);
  } finally {
    cleanupRoot(root);
  }
});

test('doctor is satisfied when the configured paths match reality', async () => {
  const root = makeRoot();
  try {
    write(root, 'tasks/current.md', 'Task-ID: T-1\n');
    write(root, 'reports/current.md', 'Task-ID: T-1\nStatus: COMPLETE\n');
    write(root, 'test/current.md', 'Task-ID: T-1\n');
    write(root, 'test/report.md', 'Task-ID: T-1\nResult: PASS\n');
    const cfg = mergeConfig(root, {});
    const { checks } = await doctor(root, cfg, { logger: createLogger(root, { quiet: true }) });
    for (const key of ['task', 'coderReport', 'testSpec', 'testReport']) {
      assert.equal(find(checks, `protocol file (${key})`).ok, true, key);
    }
  } finally {
    cleanupRoot(root);
  }
});

test('doctor reports missing agent commands and git state', async () => {
  const root = makeRoot();
  try {
    const cfg = mergeConfig(root, { coderCommand: 'definitely-not-a-real-command-xyz' });
    const { checks, ok } = await doctor(root, cfg, { logger: createLogger(root, { quiet: true }) });
    assert.equal(find(checks, 'coder command').ok, false);
    assert.equal(find(checks, 'git repository').ok, false); // makeRoot() is not a repo
    assert.equal(ok, false);

    gitRun(root, ['init', '-q', '-b', 'main']);
    const { checks: after } = await doctor(root, mergeConfig(root, {}), { logger: createLogger(root, { quiet: true }) });
    assert.equal(find(after, 'git repository').ok, true);
    assert.equal(find(after, 'git remote / upstream').ok, null); // warn: no remote yet
  } finally {
    cleanupRoot(root);
  }
});

test('doctor --probe detects whether the agent can write files headless', async () => {
  const root = makeRoot();
  try {
    // A "well-behaved" agent writes the probe file; a denied one does not.
    const writer = fakeAgent(
      root,
      'probe-writer',
      `const m = /at (\\S+) whose entire contents are exactly this one line:\\s*(\\S+)/.exec(prompt);
       fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
       fs.writeFileSync(path.join(root, m[1]), m[2] + '\\n');
       process.exit(0);`,
    );
    const denied = fakeAgent(root, 'probe-denied', `process.exit(0);`);
    const logger = createLogger(root, { quiet: true });

    const okCfg = mergeConfig(root, { agents: { coder: { command: process.execPath, args: [writer], timeoutMinutes: 1 } } });
    const good = await doctor(root, okCfg, { roles: ['coder'], logger });
    assert.equal(find(good.checks, 'coder can write files headless').ok, true);

    const badCfg = mergeConfig(root, { agents: { coder: { command: process.execPath, args: [denied], timeoutMinutes: 1 } } });
    const bad = await doctor(root, badCfg, { roles: ['coder'], logger });
    const c = find(bad.checks, 'coder can write files headless');
    assert.equal(c.ok, false);
    assert.match(c.detail, /without writing the probe file/);
  } finally {
    cleanupRoot(root);
  }
});
