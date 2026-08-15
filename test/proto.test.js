import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMsg, validateWorkerMessage, tokensEqual, isPrivateAddress, capReport, PROTO_VERSION, MAX_REPORT_BYTES } from '../src/proto.js';

test('makeMsg produces a complete envelope', () => {
  const m = makeMsg('WORKER_REGISTER', { workerId: 'w1' });
  assert.equal(m.v, PROTO_VERSION);
  assert.equal(m.type, 'WORKER_REGISTER');
  assert.equal(m.workerId, 'w1');
  assert.ok(m.id.length > 10);
  assert.ok(!Number.isNaN(Date.parse(m.ts)));
});

test('validateWorkerMessage accepts well-formed messages', () => {
  assert.equal(validateWorkerMessage(makeMsg('WORKER_REGISTER', { workerId: 'w1' })), null);
  assert.equal(validateWorkerMessage(makeMsg('WORKER_HEARTBEAT', { workerId: 'w1', sessionId: 's1' })), null);
  assert.equal(
    validateWorkerMessage(makeMsg('CODER_RESULT', { workerId: 'w1', sessionId: 's1', dispatchId: 'd1', taskId: 'T-1' })),
    null,
  );
});

test('validateWorkerMessage rejects malformed messages', () => {
  assert.match(validateWorkerMessage(null) ?? '', /not an object/);
  assert.match(validateWorkerMessage('x') ?? '', /not an object/);
  assert.match(validateWorkerMessage({}) ?? '', /version/);
  assert.match(validateWorkerMessage({ v: 99, id: 'x', ts: new Date().toISOString(), type: 'WORKER_REGISTER' }) ?? '', /version/);
  assert.match(validateWorkerMessage({ v: 1, id: '', ts: new Date().toISOString(), type: 'WORKER_REGISTER' }) ?? '', /message id/);
  assert.match(validateWorkerMessage({ v: 1, id: 'x', ts: 'not-a-date', type: 'WORKER_REGISTER' }) ?? '', /timestamp/);
  assert.match(validateWorkerMessage(makeMsg('TOTALLY_BOGUS')) ?? '', /unknown/);
  // orchestrator->worker types are not accepted inbound
  assert.match(validateWorkerMessage(makeMsg('RUN_CODER', { dispatchId: 'd', taskId: 't', prompt: 'p' })) ?? '', /unknown or unexpected/);
  // missing required field
  assert.match(validateWorkerMessage(makeMsg('WORKER_REGISTER')) ?? '', /missing field "workerId"/);
  assert.match(validateWorkerMessage(makeMsg('WORKER_GIT_CONFLICT', { workerId: 'w', sessionId: 's', dispatchId: 'd' })) ?? '', /missing field "stage"/);
});

test('tokensEqual: constant-shape comparison semantics', () => {
  assert.equal(tokensEqual('secret-token-abc', 'secret-token-abc'), true);
  assert.equal(tokensEqual('secret-token-abc', 'secret-token-abd'), false);
  assert.equal(tokensEqual('short', 'a-much-longer-token'), false);
  assert.equal(tokensEqual('', ''), false); // empty tokens never authenticate
  assert.equal(tokensEqual('x', ''), false);
});

test('isPrivateAddress covers loopback, RFC1918, link-local, and v6 forms', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.0.0.5', '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.1.1', 'fe80::1', 'fd00::1', '::ffff:192.168.0.2']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2001:4860:4860::8888', '', undefined]) {
    assert.equal(isPrivateAddress(a), false, String(a));
  }
});

test('capReport truncates oversized reports', () => {
  assert.equal(capReport(null), null);
  assert.equal(capReport('small'), 'small');
  const big = 'x'.repeat(MAX_REPORT_BYTES + 100);
  const capped = capReport(big) ?? '';
  assert.ok(capped.length < big.length);
  assert.match(capped, /truncated by pipeline/);
});
