import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig, mergeConfig, applyEnvOverrides, loadConfig } from '../src/config.js';
import { makeRoot, cleanupRoot, write } from './helpers.js';

test('defaults are sane', () => {
  const c = defaultConfig('/x');
  assert.equal(c.watchDebounceMs, 1000);
  assert.equal(c.humanGateOnPhaseComplete, true);
  assert.equal(c.agents.coder.command, 'claude');
  assert.equal(c.agents.orchestrator.command, 'agy');
  assert.equal(c.files.task, 'tasks/current.md');
  assert.equal(c.git.pullBeforeCycle, false);
});

test('flat spec-style keys are honored', () => {
  const c = mergeConfig('/x', {
    coderCommand: 'claude-x',
    testerCommand: 'claude-y',
    orchestratorCommand: 'agy2',
    watchDebounceMs: 500,
    humanGateOnPhaseComplete: false,
  });
  assert.equal(c.agents.coder.command, 'claude-x');
  assert.equal(c.agents.tester.command, 'claude-y');
  assert.equal(c.agents.orchestrator.command, 'agy2');
  assert.equal(c.watchDebounceMs, 500);
  assert.equal(c.humanGateOnPhaseComplete, false);
});

test('nested agent config overrides defaults', () => {
  const c = mergeConfig('/x', { agents: { coder: { command: 'c', args: ['--foo'], promptVia: 'arg', timeoutMinutes: 5 } } });
  assert.deepEqual(c.agents.coder, { command: 'c', args: ['--foo'], promptVia: 'arg', timeoutMinutes: 5 });
  assert.equal(c.agents.tester.command, 'claude'); // untouched
});

test('environment variables override config', () => {
  const c = applyEnvOverrides(defaultConfig('/x'), {
    ASTERIM_PIPELINE_CODER_COMMAND: 'env-coder',
    ASTERIM_PIPELINE_DEBOUNCE_MS: '250',
  });
  assert.equal(c.agents.coder.command, 'env-coder');
  assert.equal(c.watchDebounceMs, 250);
});

test('loadConfig: missing file yields defaults, malformed file throws', () => {
  const root = makeRoot();
  try {
    assert.equal(loadConfig(root, {}).agents.coder.command, 'claude');
    write(root, '.pipeline/config.json', '{ not json');
    assert.throws(() => loadConfig(root, {}), /invalid JSON/);
    write(root, '.pipeline/config.json', '[1,2]');
    assert.throws(() => loadConfig(root, {}), /expected a JSON object/);
  } finally {
    cleanupRoot(root);
  }
});

test('relative projectRoot in config resolves against invocation root', () => {
  const root = makeRoot();
  try {
    fs.mkdirSync(path.join(root, 'sub'));
    write(root, '.pipeline/config.json', JSON.stringify({ projectRoot: 'sub' }));
    assert.equal(loadConfig(root, {}).projectRoot, path.join(root, 'sub'));
  } finally {
    cleanupRoot(root);
  }
});
