// Shared test helpers: temp project roots, fake agent scripts, quiet config.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeConfig } from '../src/config.js';

/** Create an isolated temp project root with the protocol directories. */
export function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asterim-pipe-'));
  for (const d of ['tasks', 'reports', 'test', '.pipeline']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  return root;
}

/** @param {string} root */
export function cleanupRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* best effort on Windows */
  }
}

/** @param {string} root @param {string} rel @param {string} text */
export function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
}

/** @param {string} root @param {string} rel */
export function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
}

const SCRIPT_PREAMBLE = `
const fs = require('fs');
const path = require('path');
const root = process.cwd();
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => { main(); });
process.stdin.on('error', () => {});
function readTaskId() {
  const t = fs.readFileSync(path.join(root, 'tasks', 'current.md'), 'utf8');
  const m = /task-id:\\s*(\\S+)/i.exec(t);
  return m ? m[1] : 'UNKNOWN';
}
function bump(name) {
  const f = path.join(root, '.counters-' + name);
  const n = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) + 1 : 1;
  fs.writeFileSync(f, String(n));
  return n;
}
`;

/**
 * Write a fake agent script. `body` is the source of an async-free main()
 * with helpers readTaskId()/bump(name)/prompt available.
 * @param {string} root @param {string} name @param {string} body
 * @returns {string} absolute script path
 */
export function fakeAgent(root, name, body) {
  const file = path.join(root, `${name}.cjs`);
  fs.writeFileSync(file, `${SCRIPT_PREAMBLE}\nfunction main() {\n${body}\n}\n`, 'utf8');
  return file;
}

/** @param {string} root @param {string} name */
export function counter(root, name) {
  const f = path.join(root, `.counters-${name}`);
  return fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
}

/** Standard fake coder: writes a valid COMPLETE report for the current task. */
export function normalCoder(root) {
  return fakeAgent(
    root,
    'fake-coder',
    `bump('coder');
     const id = readTaskId();
     fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: ' + id + '\\nStatus: COMPLETE\\n');
     process.exit(0);`,
  );
}

/** Standard fake tester: writes PASS (or FAIL) for the current task. @param {string} root @param {'PASS'|'FAIL'} result */
export function normalTester(root, result = 'PASS') {
  return fakeAgent(
    root,
    'fake-tester',
    `bump('tester');
     fs.writeFileSync(path.join(root, 'test', 'report.md'), 'Task-ID: ' + readTaskId() + '\\nResult: ${result}\\n');
     process.exit(${result === 'PASS' ? 0 : 1});`,
  );
}

/**
 * Fake orchestrator: writes tasks in sequence T-2, T-3, ... and records the
 * prompt it received; declares PHASE_COMPLETE after `phaseAfter` invocations.
 * @param {string} root @param {{phaseAfter?: number}} [opts]
 */
export function normalOrchestrator(root, opts = {}) {
  const phaseAfter = opts.phaseAfter ?? Infinity;
  return fakeAgent(
    root,
    'fake-orch',
    `const n = bump('orch');
     fs.writeFileSync(path.join(root, '.orch-prompt-' + n), prompt);
     const taskFile = path.join(root, 'tasks', 'current.md');
     if (n >= ${Number.isFinite(phaseAfter) ? phaseAfter : 'Infinity'}) {
       fs.writeFileSync(taskFile, 'Status: PHASE_COMPLETE\\nPhase: 1\\n');
     } else {
       fs.writeFileSync(taskFile, 'Task-ID: T-' + (n + 1) + '\\nPhase: 1\\n\\nNext task body.\\n');
       fs.writeFileSync(path.join(root, 'test', 'current.md'), 'Task-ID: T-' + (n + 1) + '\\nRun the tests.\\n');
     }
     process.exit(0);`,
  );
}

/**
 * Protocol paths the fixtures write. Pinned so the suite is independent of
 * whatever `files` default a project happens to be configured with.
 */
export const TEST_FILES = {
  task: 'tasks/current.md',
  coderReport: 'reports/current.md',
  testSpec: 'test/current.md',
  testReport: 'test/report.md',
};

/**
 * Build a test config wired to fake agent scripts, git disabled by default.
 * @param {string} root
 * @param {{coder?: string, tester?: string, orchestrator?: string, raw?: Record<string, any>}} agents
 */
export function testConfig(root, agents) {
  const scriptAgent = (/** @type {string|undefined} */ script) =>
    script
      ? { command: process.execPath, args: [script], promptVia: 'stdin', timeoutMinutes: 1 }
      : { command: process.execPath, args: ['-e', 'process.exit(97)'], promptVia: 'stdin', timeoutMinutes: 1 };
  return mergeConfig(root, {
    watchDebounceMs: 150,
    git: { enabled: false },
    files: { ...TEST_FILES },
    agents: {
      coder: scriptAgent(agents.coder),
      tester: scriptAgent(agents.tester),
      orchestrator: scriptAgent(agents.orchestrator),
    },
    ...(agents.raw ?? {}),
  });
}

/** A logger that only writes to the log file, not the console. */
export { createLogger } from '../src/logger.js';

/** Sleep helper for watcher tests. @param {number} ms */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {() => boolean} cond @param {number} [timeoutMs] */
export async function waitFor(cond, timeoutMs = 8000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

/** Run git in a directory, asserting success. @param {string} cwd @param {string[]} args */
export function gitRun(cwd, args) {
  const { spawnSync } = /** @type {typeof import('node:child_process')} */ (require_child());
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return (res.stdout ?? '').trim();
}

// Lazy import shim so plain-ESM helpers keep working under node:test.
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
function require_child() {
  return require_('node:child_process');
}

/**
 * Distributed-mode fixture: a bare origin plus two clones sharing it.
 * Both clones get git user config and the protocol/pipeline directories.
 * @returns {{origin: string, orchRoot: string, workerRoot: string, cleanup: () => void}}
 */
export function makeGitPair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'asterim-dist-'));
  const origin = path.join(base, 'origin.git');
  const orchRoot = path.join(base, 'orch');
  const workerRoot = path.join(base, 'worker');
  fs.mkdirSync(origin, { recursive: true });
  gitRun(origin, ['init', '--bare', '-q', '-b', 'main']);
  gitRun(base, ['clone', '-q', origin, orchRoot]);
  gitRun(orchRoot, ['config', 'user.email', 'test@example.com']);
  gitRun(orchRoot, ['config', 'user.name', 'Test']);
  gitRun(orchRoot, ['checkout', '-q', '-b', 'main']);
  for (const d of ['tasks', 'reports', 'test', '.pipeline']) fs.mkdirSync(path.join(orchRoot, d), { recursive: true });
  fs.writeFileSync(path.join(orchRoot, 'README.md'), 'seed\n', 'utf8');
  fs.writeFileSync(path.join(orchRoot, '.gitignore'), '.pipeline/\n.counters-*\n*.cjs\n.orch-prompt-*\n', 'utf8');
  gitRun(orchRoot, ['add', '-A']);
  gitRun(orchRoot, ['commit', '-q', '-m', 'seed']);
  gitRun(orchRoot, ['push', '-q', '-u', 'origin', 'main']);
  gitRun(base, ['clone', '-q', origin, workerRoot]);
  gitRun(workerRoot, ['config', 'user.email', 'worker@example.com']);
  gitRun(workerRoot, ['config', 'user.name', 'Worker']);
  for (const d of ['tasks', 'reports', 'test', '.pipeline']) fs.mkdirSync(path.join(workerRoot, d), { recursive: true });
  return {
    origin,
    orchRoot,
    workerRoot,
    cleanup: () => cleanupRoot(base),
  };
}
