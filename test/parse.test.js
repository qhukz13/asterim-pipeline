import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskFile, parseCoderReport, parseTestReport, parseTestSpec, sha256 } from '../src/parse.js';

test('parseTaskFile extracts Task-ID, Phase, No-Code-Changes', () => {
  const t = parseTaskFile('# Implement widget\n\nTask-ID: P6-03\nPhase: 6\nNo-Code-Changes: true\n\nDo the thing.');
  assert.equal(t.valid, true);
  assert.equal(t.taskId, 'P6-03');
  assert.equal(t.phase, '6');
  assert.equal(t.phaseComplete, false);
  assert.equal(t.expectCodeChanges, false);
});

test('parseTaskFile accepts heading form and defaults expectCodeChanges', () => {
  const t = parseTaskFile('# Task P1-01\nsome body');
  assert.equal(t.taskId, 'P1-01');
  assert.equal(t.expectCodeChanges, true);
});

test('parseTaskFile detects PHASE_COMPLETE (case/sep insensitive)', () => {
  for (const s of ['Status: PHASE_COMPLETE', 'status = phase-complete', 'Status: Phase Complete'.replace(' Complete', '_Complete')]) {
    const t = parseTaskFile(`${s}\n`);
    assert.equal(t.phaseComplete, true, s);
    assert.equal(t.valid, true);
  }
});

test('parseTaskFile rejects empty/missing/garbage', () => {
  assert.equal(parseTaskFile(null).valid, false);
  assert.equal(parseTaskFile('').valid, false);
  assert.equal(parseTaskFile('just some prose with no fields').valid, false);
  // "PHASE_COMPLETE" mentioned in prose must not count
  assert.equal(parseTaskFile('we will later reach PHASE_COMPLETE state').valid, false);
});

test('parseCoderReport recognizes statuses and normalizes', () => {
  const r = parseCoderReport('Task-ID: T-1\nStatus: completed\n');
  assert.deepEqual([r.valid, r.taskId, r.status], [true, 'T-1', 'COMPLETE']);
  assert.equal(parseCoderReport('Task-ID: T-1\nStatus: BLOCKED\n').status, 'BLOCKED');
  assert.equal(parseCoderReport('Task-ID: T-1\nStatus: failed\n').status, 'FAILED');
});

test('parseCoderReport flags malformed reports', () => {
  assert.equal(parseCoderReport('Task-ID: T-1\n').valid, false);
  assert.equal(parseCoderReport('Status: COMPLETE\n').valid, false);
  const weird = parseCoderReport('Task-ID: T-1\nStatus: MAYBE\n');
  assert.equal(weird.valid, false);
  assert.match(weird.problems.join(' '), /unrecognized coder status/);
});

test('parseTestReport recognizes PASS/FAIL via Result or Status', () => {
  assert.equal(parseTestReport('Task-ID: T-1\nResult: PASS\n').result, 'PASS');
  assert.equal(parseTestReport('Task-ID: T-1\nStatus: failed\n').result, 'FAIL');
  assert.equal(parseTestReport('Task-ID: T-1\nResult: 7/9 passed\n').valid, false);
  assert.equal(parseTestReport(null).valid, false);
});

test('parseTestSpec', () => {
  assert.equal(parseTestSpec(null).exists, false);
  assert.equal(parseTestSpec('  \n').exists, false);
  const s = parseTestSpec('Task-ID: T-2\nrun unit tests');
  assert.deepEqual([s.exists, s.taskId], [true, 'T-2']);
});

test('sha256 is stable and content-sensitive', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.notEqual(sha256('a'), sha256('b'));
});
