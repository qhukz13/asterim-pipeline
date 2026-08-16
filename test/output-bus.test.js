import test from 'node:test';
import assert from 'node:assert/strict';
import { OutputBus } from '../src/output-bus.js';

test('only complete lines are published; fragments wait for their newline', () => {
  const bus = new OutputBus();
  bus.append('coder', 'hello ');
  assert.equal(bus.since(0).lines.length, 0);
  bus.append('coder', 'world\nsecond line');
  assert.deepEqual(bus.since(0).lines.map((l) => l.text), ['hello world']);
  bus.flush('coder');
  assert.deepEqual(bus.since(0).lines.map((l) => l.text), ['hello world', 'second line']);
});

test('lines are formatted and tagged with their role', () => {
  const bus = new OutputBus();
  bus.append('tester', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}}\n');
  const [line] = bus.since(0).lines;
  assert.equal(line.role, 'tester');
  assert.equal(line.text, '▸ Bash  npm test');
  assert.ok(!Number.isNaN(Date.parse(line.at)));
});

test('roles keep separate partial buffers', () => {
  const bus = new OutputBus();
  bus.append('coder', 'coder part');
  bus.append('tester', 'tester line\n');
  bus.append('coder', ' finished\n');
  assert.deepEqual(bus.since(0).lines.map((l) => `${l.role}:${l.text}`), ['tester:tester line', 'coder:coder part finished']);
});

test('the cursor returns only new lines', () => {
  const bus = new OutputBus();
  bus.append('coder', 'one\ntwo\n');
  const first = bus.since(0);
  assert.deepEqual(first.lines.map((l) => l.text), ['one', 'two']);
  assert.equal(bus.since(first.cursor).lines.length, 0);
  bus.append('coder', 'three\n');
  const next = bus.since(first.cursor);
  assert.deepEqual(next.lines.map((l) => l.text), ['three']);
  assert.equal(next.cursor, first.cursor + 1);
});

test('the ring is bounded and a stale cursor is reported as dropped', () => {
  const bus = new OutputBus({ maxLines: 10 });
  for (let i = 0; i < 50; i++) bus.append('coder', `line ${i}\n`);
  assert.equal(bus.lines.length, 10);
  assert.equal(bus.since(0).lines.at(-1)?.text, 'line 49');
  // A client holding a cursor from before the truncation is told to resync
  // rather than silently missing output.
  const stale = bus.since(2);
  assert.equal(stale.dropped, true);
  assert.equal(stale.lines.length, 10);
  assert.equal(bus.since(bus.seq).dropped, false);
});

test('marks separate one agent run from the next', () => {
  const bus = new OutputBus();
  bus.append('coder', 'trailing fragment');
  bus.mark('coder', 'coder started for P6-06');
  const texts = bus.since(0).lines.map((l) => l.text);
  assert.deepEqual(texts, ['trailing fragment', '— coder started for P6-06 —']);
});

test('empty and whitespace chunks never create lines', () => {
  const bus = new OutputBus();
  bus.append('coder', '');
  bus.append('coder', '\n\n');
  bus.flush('coder');
  assert.equal(bus.since(0).lines.length, 0);
});
