import test from 'node:test';
import assert from 'node:assert/strict';
import { readState, writeState, defaultState } from '../src/store.js';
import { makeRoot, cleanupRoot, write } from './helpers.js';

test('state roundtrips atomically', () => {
  const root = makeRoot();
  try {
    const s = defaultState();
    s.state = 'TESTING';
    s.taskId = 'P6-03';
    s.phase = '6';
    s.coderPid = 1234;
    writeState(root, s);
    const back = readState(root);
    assert.equal(back.existed, true);
    assert.equal(back.corrupt, false);
    assert.equal(back.state.state, 'TESTING');
    assert.equal(back.state.taskId, 'P6-03');
    assert.equal(back.state.coderPid, 1234);
    assert.ok(back.state.updatedAt);
  } finally {
    cleanupRoot(root);
  }
});

test('missing state file yields defaults', () => {
  const root = makeRoot();
  try {
    const r = readState(root);
    assert.deepEqual([r.existed, r.corrupt, r.state.state], [false, false, 'IDLE']);
  } finally {
    cleanupRoot(root);
  }
});

test('corrupt state file is reported, not guessed at', () => {
  const root = makeRoot();
  try {
    write(root, '.pipeline/state.json', '{"state": '); // truncated write
    let r = readState(root);
    assert.deepEqual([r.existed, r.corrupt], [true, true]);
    write(root, '.pipeline/state.json', '"just a string"');
    r = readState(root);
    assert.equal(r.corrupt, true);
  } finally {
    cleanupRoot(root);
  }
});

test('unknown extra fields survive and known fields merge over defaults', () => {
  const root = makeRoot();
  try {
    write(root, '.pipeline/state.json', JSON.stringify({ state: 'IDLE', tasksExecuted: 9 }));
    const r = readState(root);
    assert.equal(r.corrupt, false);
    assert.equal(r.state.tasksExecuted, 9);
    assert.equal(r.state.consecutiveTestFailures, 0); // default filled in
  } finally {
    cleanupRoot(root);
  }
});
