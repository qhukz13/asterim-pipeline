// Fixtures below are real lines captured from
//   claude -p --verbose --output-format stream-json
// (trimmed), so the formatter is tested against the actual shapes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAgentLine, formatAgentOutput } from '../src/agent-stream.js';

const INIT = JSON.stringify({
  type: 'system', subtype: 'init', cwd: 'C:\\tmp', session_id: '08d2122d',
  tools: ['Bash', 'Edit', 'Read', 'Write'], model: 'claude-opus-4-8[1m]', permissionMode: 'default',
});

const RESULT_ERR = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, duration_ms: 637, num_turns: 1,
  result: 'Not logged in · Please run /login', total_cost_usd: 0, permission_denials: [],
});

test('system init renders model, tool count and permission mode', () => {
  const out = formatAgentLine(INIT);
  assert.equal(out.length, 1);
  assert.match(out[0], /session start/);
  assert.match(out[0], /claude-opus-4-8/);
  assert.match(out[0], /4 tools/);
  assert.match(out[0], /permissions: default/);
});

test('assistant text becomes one display line per non-empty line', () => {
  const ev = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'First line\n\nSecond line' }] },
  });
  assert.deepEqual(formatAgentLine(ev), ['First line', 'Second line']);
});

test('tool_use renders the tool and its most relevant argument', () => {
  const mk = (/** @type {string} */ name, /** @type {any} */ input) =>
    formatAgentLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } }))[0];

  assert.equal(mk('Edit', { file_path: 'src/BaseAdapter.ts', old_string: 'a', new_string: 'b' }), '▸ Edit  src/BaseAdapter.ts');
  assert.equal(mk('Bash', { command: 'pnpm typecheck', description: 'typecheck' }), '▸ Bash  pnpm typecheck');
  assert.equal(mk('Grep', { pattern: 'TODO' }), '▸ Grep  TODO');
  assert.equal(mk('Weird', { alpha: 1, beta: 2 }), '▸ Weird  {alpha, beta}');
  assert.equal(mk('NoArgs', {}), '▸ NoArgs');
});

test('thinking blocks are dropped, assistant errors are surfaced', () => {
  const thinking = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } });
  assert.deepEqual(formatAgentLine(thinking), []);
  const errored = JSON.stringify({
    type: 'assistant', error: 'authentication_failed',
    message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
  });
  assert.deepEqual(formatAgentLine(errored), ['Not logged in · Please run /login', '✗ authentication_failed']);
});

test('only failing tool results are shown', () => {
  const ok = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'fine' }] } });
  assert.deepEqual(formatAgentLine(ok), []);
  const bad = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', is_error: true, content: 'EACCES: permission denied' }] },
  });
  assert.deepEqual(formatAgentLine(bad), ['  ✗ EACCES: permission denied']);
});

test('result renders duration, turns and cost', () => {
  const ok = formatAgentLine(JSON.stringify({
    type: 'result', is_error: false, duration_ms: 95000, num_turns: 42, total_cost_usd: 1.234,
  }));
  assert.equal(ok.length, 1);
  assert.match(ok[0], /✓ finished/);
  assert.match(ok[0], /1m 35s/);
  assert.match(ok[0], /42 turns/);
  assert.match(ok[0], /\$1\.23/);
});

test('result surfaces permission denials — the headless failure that matters', () => {
  const out = formatAgentLine(JSON.stringify({
    type: 'result', is_error: false, duration_ms: 500,
    permission_denials: [{ tool_name: 'Write' }, { tool_name: 'Bash' }, { tool_name: 'Write' }],
  }));
  assert.match(out[0], /✓ finished/);
  assert.match(out[1], /permission denied: Write, Bash/);
  assert.ok(!out[1].includes('Write, Bash, Write'), 'duplicates should collapse');
});

test('a real failing result line renders the reason', () => {
  const out = formatAgentLine(RESULT_ERR);
  assert.match(out[0], /✗ failed/);
  assert.match(out[0], /637ms/);
  assert.match(out.join('\n'), /Not logged in/);
});

test('non-JSON and malformed lines pass through untouched', () => {
  assert.deepEqual(formatAgentLine('plain agy output line'), ['plain agy output line']);
  assert.deepEqual(formatAgentLine('{not valid json'), ['{not valid json']);
  assert.deepEqual(formatAgentLine('   '), []);
  assert.deepEqual(formatAgentLine('[1,2,3]'), ['[1,2,3]']);
  // an unknown event type is noted, never swallowed
  assert.deepEqual(formatAgentLine('{"type":"future_thing"}'), ['· future_thing']);
});

test('formatAgentOutput handles a whole transcript', () => {
  const text = [INIT, '', 'raw trailing note', RESULT_ERR].join('\n');
  const out = formatAgentOutput(text);
  assert.match(out, /session start/);
  assert.match(out, /raw trailing note/);
  assert.match(out, /✗ failed/);
  assert.ok(!out.includes('"type"'), 'no raw JSON should survive for known events');
});
