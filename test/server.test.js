// OrchestratorServer unit tests over real HTTP on 127.0.0.1.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OrchestratorServer } from '../src/server.js';
import { makeMsg, MSG } from '../src/proto.js';
import { createLogger } from '../src/logger.js';
import { makeRoot, cleanupRoot, sleep, waitFor } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef';

/** @param {Partial<import('../src/config.js').Config['remote']>} [over] */
function remoteCfg(over = {}) {
  return {
    bind: '127.0.0.1', port: 0, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400,
    pollTimeoutMs: 300, redeliverMs: 100, dispatchGraceMinutes: 1,
    allowPublicClients: false, autoCommitTaskFiles: true, ...over,
  };
}

/** @param {string} root @param {Partial<import('../src/config.js').Config['remote']>} [over] */
async function startServer(root, over) {
  const server = new OrchestratorServer({ root, remoteCfg: remoteCfg(over), token: TOKEN, logger: createLogger(root, { quiet: true }) });
  const port = await server.listen();
  return { server, port };
}

/** @param {number} port @param {string} pathName @param {unknown} body @param {string} [token] */
async function post(port, pathName, body, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {Record<string, any>} */ (await res.json().catch(() => ({}))) };
}

/** @param {number} port @param {string} [workerId] */
async function register(port, workerId = 'laptop-01') {
  const r = await post(port, '/v1/register', makeMsg(MSG.WORKER_REGISTER, { workerId }));
  assert.equal(r.status, 200);
  return /** @type {string} */ (r.body.sessionId);
}

test('server: rejects invalid and missing tokens with 401', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const bad = await post(port, '/v1/register', makeMsg(MSG.WORKER_REGISTER, { workerId: 'w' }), 'wrong-token');
    assert.equal(bad.status, 401);
    const none = await fetch(`http://127.0.0.1:${port}/v1/register`, { method: 'POST', body: '{}' });
    assert.equal(none.status, 401);
    assert.equal(server.online(), false);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: rejects malformed messages with 400', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    assert.equal((await post(port, '/v1/register', 'this is not json')).status, 400);
    assert.equal((await post(port, '/v1/register', { hello: 'world' })).status, 400);
    assert.equal((await post(port, '/v1/register', makeMsg(MSG.WORKER_HEARTBEAT, { workerId: 'w', sessionId: 's' }))).status, 400); // wrong type for endpoint
    const noWorkerId = await post(port, '/v1/register', makeMsg(MSG.WORKER_REGISTER));
    assert.equal(noWorkerId.status, 400);
    assert.match(noWorkerId.body.error, /workerId/);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: registration creates a session and persists workers.json', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const sessionId = await register(port);
    assert.ok(sessionId.length > 10);
    assert.equal(server.online(), true);
    assert.equal(server.workerId(), 'laptop-01');
    const wf = JSON.parse(fs.readFileSync(path.join(root, '.pipeline', 'workers.json'), 'utf8'));
    assert.equal(wf.workers[0].workerId, 'laptop-01');
    assert.equal(wf.workers[0].online, true);
    // a second, different worker is rejected while the first is online
    const second = await post(port, '/v1/register', makeMsg(MSG.WORKER_REGISTER, { workerId: 'other' }));
    assert.equal(second.status, 409);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: heartbeat updates liveness and agent info; stale sessions are rejected', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const s1 = await register(port);
    const hb = await post(port, '/v1/heartbeat', makeMsg(MSG.WORKER_HEARTBEAT, { workerId: 'laptop-01', sessionId: s1, currentAgent: 'coder', taskId: 'P6-01' }));
    assert.equal(hb.status, 200);
    assert.equal(server.workersInfo()[0].currentAgent, 'coder');
    assert.equal(server.workersInfo()[0].taskId, 'P6-01');
    // reconnect: same worker re-registers -> new session; old one is now stale
    const s2 = await register(port);
    assert.notEqual(s1, s2);
    const stale = await post(port, '/v1/heartbeat', makeMsg(MSG.WORKER_HEARTBEAT, { workerId: 'laptop-01', sessionId: s1 }));
    assert.equal(stale.status, 403);
    const fresh = await post(port, '/v1/heartbeat', makeMsg(MSG.WORKER_HEARTBEAT, { workerId: 'laptop-01', sessionId: s2 }));
    assert.equal(fresh.status, 200);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: worker disconnect is detected after the heartbeat timeout and rejects a pending dispatch', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    await register(port);
    /** @type {string[]} */
    const events = [];
    server.on('worker-offline', (id) => events.push(`off:${id}`));
    const dispatched = server.dispatch('coder', { taskId: 'T-1', prompt: 'p' }, { timeoutMs: 10000 });
    const err = await dispatched.catch((e) => e);
    assert.equal(err.kind, 'offline');
    assert.deepEqual(events, ['off:laptop-01']);
    assert.equal(server.online(), false);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: dispatch is delivered via poll, redelivered after redeliverMs, and resolved by a matching result', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const sessionId = await register(port);
    const poll = () => post(port, '/v1/poll', makeMsg(MSG.WORKER_POLL, { workerId: 'laptop-01', sessionId }));

    // no command yet -> NONE after pollTimeoutMs
    assert.equal((await poll()).body.type, MSG.NONE);

    const resultP = server.dispatch('coder', { taskId: 'T-1', prompt: 'do it' }, { timeoutMs: 10000 });
    const first = (await poll()).body;
    assert.equal(first.type, MSG.RUN_CODER);
    assert.equal(first.taskId, 'T-1');
    assert.equal(first.prompt, 'do it');

    // duplicate delivery: after redeliverMs the same dispatchId is offered again
    await sleep(150);
    const second = (await poll()).body;
    assert.equal(second.type, MSG.RUN_CODER);
    assert.equal(second.dispatchId, first.dispatchId);

    // a stale/foreign result is ignored, the pending dispatch stays pending
    await post(port, '/v1/result', makeMsg(MSG.CODER_RESULT, { workerId: 'laptop-01', sessionId, dispatchId: 'bogus', taskId: 'T-1', exitCode: 0 }));

    await post(port, '/v1/result', makeMsg(MSG.CODER_RESULT, {
      workerId: 'laptop-01', sessionId, dispatchId: first.dispatchId, taskId: 'T-1',
      exitCode: 0, committed: true, pushed: true, reportContent: 'Task-ID: T-1\nStatus: COMPLETE\n',
    }));
    const result = await resultP;
    assert.equal(result.type, MSG.CODER_RESULT);
    assert.equal(result.committed, true);
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: dispatch while offline rejects immediately; only one pending dispatch at a time', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const offlineErr = await server.dispatch('coder', { taskId: 'T', prompt: 'p' }, { timeoutMs: 1000 }).catch((e) => e);
    assert.equal(offlineErr.kind, 'offline');
    const sessionId = await register(port);
    const p1 = server.dispatch('coder', { taskId: 'T', prompt: 'p' }, { timeoutMs: 5000 });
    const busyErr = await server.dispatch('tester', { taskId: 'T', prompt: 'p' }, { timeoutMs: 5000 }).catch((e) => e);
    assert.equal(busyErr.kind, 'busy');
    // clean up p1 via a result
    const poll = await post(port, '/v1/poll', makeMsg(MSG.WORKER_POLL, { workerId: 'laptop-01', sessionId }));
    await post(port, '/v1/result', makeMsg(MSG.CODER_RESULT, { workerId: 'laptop-01', sessionId, dispatchId: poll.body.dispatchId, taskId: 'T', exitCode: 0 }));
    await p1;
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: PAUSE is reported to a polling worker; queued STOP is delivered once', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const sessionId = await register(port);
    const poll = () => post(port, '/v1/poll', makeMsg(MSG.WORKER_POLL, { workerId: 'laptop-01', sessionId }));
    server.setPaused(true);
    assert.equal((await poll()).body.type, MSG.PAUSE);
    server.setPaused(false);
    server.queueStop();
    assert.equal((await poll()).body.type, MSG.STOP);
    assert.equal((await poll()).body.type, MSG.NONE); // delivered exactly once
  } finally {
    server.close();
    cleanupRoot(root);
  }
});

test('server: heartbeats keep a worker online across the timeout window', async () => {
  const root = makeRoot();
  const { server, port } = await startServer(root);
  try {
    const sessionId = await register(port);
    for (let i = 0; i < 4; i++) {
      await sleep(150);
      await post(port, '/v1/heartbeat', makeMsg(MSG.WORKER_HEARTBEAT, { workerId: 'laptop-01', sessionId }));
    }
    assert.equal(server.online(), true); // 600ms elapsed > timeout 400ms, but heartbeats kept it alive
    await waitFor(() => !server.online(), 3000); // then it dies without them
  } finally {
    server.close();
    cleanupRoot(root);
  }
});
