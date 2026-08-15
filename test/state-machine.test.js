import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, TRANSITIONS, canTransition, assertTransition, isState } from '../src/state-machine.js';

test('normal flow transitions are allowed', () => {
  const flow = ['IDLE', 'TASK_READY', 'CODING', 'CODE_REPORT_READY', 'TESTING', 'TEST_REPORT_READY', 'ORCHESTRATING', 'TASK_READY'];
  for (let i = 0; i < flow.length - 1; i++) {
    assert.equal(canTransition(flow[i], flow[i + 1]), true, `${flow[i]} -> ${flow[i + 1]}`);
  }
});

test('failure/blocked branches are allowed', () => {
  assert.ok(canTransition('CODING', 'BLOCKED'));
  assert.ok(canTransition('BLOCKED', 'ORCHESTRATING'));
  assert.ok(canTransition('CODE_REPORT_READY', 'ORCHESTRATING')); // no test spec -> skip testing
  assert.ok(canTransition('ORCHESTRATING', 'IDLE'));
});

test('every state can reach HUMAN_GATE except none', () => {
  for (const s of STATES) {
    if (s === 'HUMAN_GATE') continue;
    assert.ok(canTransition(s, 'HUMAN_GATE') || s === 'FAILED', `${s} -> HUMAN_GATE`);
  }
});

test('nonsense transitions are rejected', () => {
  assert.equal(canTransition('IDLE', 'TESTING'), false);
  assert.equal(canTransition('CODING', 'ORCHESTRATING'), false);
  assert.equal(canTransition('TESTING', 'CODING'), false);
  assert.throws(() => assertTransition('IDLE', 'TESTING'), /illegal state transition/);
});

test('transition table only references known states', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    assert.ok(isState(from), from);
    for (const to of tos) assert.ok(isState(to), `${from} -> ${to}`);
  }
  assert.equal(Object.keys(TRANSITIONS).length, STATES.length);
});
