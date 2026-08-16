import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMarkdown, parseTransitions, dashboardData } from '../src/dashboard-data.js';
import { dashboardHtml } from '../src/dashboard.js';
import { DEFAULT_FILES } from '../src/config.js';
import { makeRoot, cleanupRoot, write, gitRun } from './helpers.js';

const TASK = `Task-ID: P6-06
Phase: 6

# Skills subsystem: parser and MCP bridge

Extend the P6-04/P6-05 MCP subsystem with a skills parser so \`.agents/skills/\`
entries become callable tools.

## Acceptance criteria
- Frontmatter parser handles \`>\` and \`|\` block scalars
- **skill__<name>** tools routed through McpAgentBridge.executeTool
- Skills tab rendered alongside McpServerExplorer
1. Typecheck, lint and all 31 test suites pass

## Notes
Not criteria: this bullet must not be picked up.
`;

test('summarizeMarkdown extracts title, gist and acceptance criteria', () => {
  const s = summarizeMarkdown(TASK);
  assert.ok(s);
  assert.equal(s.title, 'Skills subsystem: parser and MCP bridge');
  assert.match(s.summary, /^Extend the P6-04\/P6-05 MCP subsystem/);
  assert.equal(s.criteria.length, 4);
  assert.equal(s.criteria[1], 'skill__<name> tools routed through McpAgentBridge.executeTool');
  assert.equal(s.criteria[3], 'Typecheck, lint and all 31 test suites pass');
  assert.ok(!s.criteria.some((c) => c.includes('must not be picked up')));
  // metadata lines are stripped from the prose, but kept out of the title too
  assert.ok(!s.summary.includes('Task-ID'));
  assert.equal(s.bytes, Buffer.byteLength(TASK, 'utf8'));
});

test('summarizeMarkdown looks past a generic section heading for the real title', () => {
  // The shape Antigravity actually writes: "## Objective" then the subject.
  const s = summarizeMarkdown(`Task-ID: P6-06
Phase: 6

## Objective
Reusable Agent Skills Engine, Schema Parser & Workspace Discovery

Implement SkillService so skills become callable tools.

## Acceptance Criteria
- SkillService discovers skills from workspace and global directories
`);
  assert.ok(s);
  assert.equal(s.title, 'Reusable Agent Skills Engine, Schema Parser & Workspace Discovery');
  assert.equal(s.summary, 'Implement SkillService so skills become callable tools.');
  assert.deepEqual(s.criteria, ['SkillService discovers skills from workspace and global directories']);
});

test('summarizeMarkdown keeps a long opening paragraph as the summary', () => {
  const long = 'This task requires a great deal of explanation, ' + 'and more detail still, '.repeat(8);
  const s = summarizeMarkdown(`Task-ID: T-9\n\n## Overview\n${long}\n`);
  assert.ok(s);
  assert.match(s.title ?? '', /^This task requires a great deal of explanation/);
  assert.ok((s.title ?? '').endsWith('…'));
  assert.match(s.summary, /^This task requires/);
});

test('summarizeMarkdown copes with plain, empty and heading-less files', () => {
  assert.equal(summarizeMarkdown(null), null);
  assert.equal(summarizeMarkdown('   \n\n'), null);
  const plain = summarizeMarkdown('Task-ID: T-1\n\nJust do the thing, carefully.\n');
  assert.ok(plain);
  assert.equal(plain.title, 'Just do the thing, carefully.');
  assert.equal(plain.criteria.length, 0);
  // a metadata-only file has no prose left
  const metaOnly = summarizeMarkdown('Task-ID: T-1\nStatus: COMPLETE\n');
  assert.ok(metaOnly);
  assert.equal(metaOnly.summary, '');
});

test('summarizeMarkdown clips very long bodies', () => {
  const big = 'Task-ID: T-1\n\n' + 'x'.repeat(20000);
  const s = summarizeMarkdown(big);
  assert.ok(s);
  assert.ok(s.body.length < 7000);
  assert.match(s.body, /more characters/);
  assert.equal(s.bytes, Buffer.byteLength(big, 'utf8'));
});

test('parseTransitions pulls state changes out of log lines', () => {
  const lines = [
    '2026-08-16T10:00:00.000Z [INFO] pipeline starting (root=/x)',
    '2026-08-16T10:00:01.000Z [INFO] state IDLE -> TASK_READY',
    '2026-08-16T10:00:02.000Z [INFO] dispatching coder to worker fedora (task P6-06)',
    '2026-08-16T10:00:03.000Z [INFO] state TASK_READY -> CODING',
    '2026-08-16T10:06:00.000Z [ERROR] HUMAN_GATE (from CODING): something',
  ];
  const t = parseTransitions(lines);
  assert.equal(t.length, 2);
  assert.deepEqual(t[1], { at: '2026-08-16T10:00:03.000Z', from: 'TASK_READY', to: 'CODING' });
});

test('dashboardData assembles a full snapshot without throwing on missing pieces', () => {
  const root = makeRoot();
  try {
    // Nothing present at all: must still return a usable object.
    const empty = dashboardData(root, DEFAULT_FILES);
    assert.equal(empty.state.state, 'IDLE');
    assert.deepEqual(empty.workers, []);
    assert.equal(empty.task, null);
    assert.equal(empty.git, null);

    write(root, DEFAULT_FILES.task, TASK);
    write(root, DEFAULT_FILES.coderReport, 'Task-ID: P6-06\nStatus: COMPLETE\n\nDid the work.\n');
    write(root, DEFAULT_FILES.testReport, 'Task-ID: P6-06\nResult: PASS\n\n31/31 suites green.\n');
    write(root, '.pipeline/pipeline.log', [
      '2026-08-16T10:00:01.000Z [INFO] state IDLE -> TASK_READY',
      '2026-08-16T10:00:03.000Z [INFO] state TASK_READY -> CODING',
    ].join('\n') + '\n');
    write(root, '.pipeline/workers.json', JSON.stringify({
      workers: [{ workerId: 'fedora', online: true, currentAgent: 'coder', taskId: 'P6-06', lastSeenAt: new Date().toISOString() }],
    }));
    gitRun(root, ['init', '-q', '-b', 'main']);
    gitRun(root, ['config', 'user.email', 't@e.com']);
    gitRun(root, ['config', 'user.name', 'T']);
    gitRun(root, ['add', '-A']);
    gitRun(root, ['commit', '-q', '-m', 'seed commit']);

    const d = dashboardData(root, DEFAULT_FILES, { agents: { coder: 'claude -p' }, port: 4317 });
    assert.equal(d.task?.title, 'Skills subsystem: parser and MCP bridge');
    // Short reports put their single line in `title`; the UI falls back to it.
    assert.match(d.coderReport?.summary || d.coderReport?.title || '', /Did the work/);
    assert.match(d.testReport?.summary || d.testReport?.title || '', /31\/31/);
    assert.equal(d.workers[0].workerId, 'fedora');
    assert.equal(d.transitions.length, 2);
    assert.equal(d.stateSince, null); // current state IDLE was never entered in the log
    assert.equal(d.git?.head.subject, 'seed commit');
    assert.equal(d.git?.branch, 'main');
    assert.equal(d.config.port, 4317);
    assert.equal(d.config.agents.coder, 'claude -p');
    assert.ok(d.log.length >= 2);
    // the payload must stay JSON-serializable for the endpoint
    assert.doesNotThrow(() => JSON.stringify(d));
  } finally {
    cleanupRoot(root);
  }
});

test('dashboardData honors non-default protocol file locations', () => {
  const root = makeRoot();
  try {
    const files = { task: 'tasks/current.md', coderReport: 'reports/current.md', testSpec: 'tests/current.md', testReport: 'tests/report.md' };
    write(root, 'tests/report.md', 'Task-ID: P6-06\nResult: PASS\n\nFrom the tests/ directory.\n');
    write(root, 'test/report.md', 'Task-ID: OLD\nResult: FAIL\n\nWrong directory.\n');
    const d = dashboardData(root, files);
    assert.match(d.testReport?.summary || d.testReport?.title || '', /From the tests\/ directory/);
    assert.ok(!(d.testReport?.body ?? '').includes('Wrong directory'));
  } finally {
    cleanupRoot(root);
  }
});

test('dashboardHtml is self-contained and escapes nothing server-side', () => {
  const html = dashboardHtml();
  assert.match(html, /<title>asterim-pipeline<\/title>/);
  assert.ok(!/src\s*=\s*["']http/i.test(html), 'must not load external scripts');
  assert.ok(!/href\s*=\s*["']http/i.test(html), 'must not load external styles');
  assert.match(html, /\/dashboard\/data/);
});
