// Orchestrator-side LAN server (node:http, zero dependencies).
//
// The orchestrator listens; the worker dials out, registers, then long-polls
// for commands (RUN_CODER / RUN_TESTER / PAUSE / STOP / NONE) and POSTs
// heartbeats and results back. Commands are delivered at-least-once (an
// unacknowledged command is re-offered every remote.redeliverMs); the worker
// deduplicates by dispatchId, so duplicates never launch a second agent.
//
// Endpoints (all POST, JSON, Bearer-token authenticated):
//   /v1/register   WORKER_REGISTER   -> REGISTERED {sessionId, ...}
//   /v1/poll       WORKER_POLL       -> RUN_* | PAUSE | STOP | NONE (long-poll)
//   /v1/heartbeat  WORKER_HEARTBEAT  -> ACK
//   /v1/result     CODER_RESULT | TESTER_RESULT | WORKER_GIT_CONFLICT | ERROR -> ACK
//
// Exactly one worker at a time: a register with a different workerId while
// another is online is rejected; re-registering the same workerId replaces
// the session (reconnect).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PIPELINE_DIR } from './config.js';
import { MSG, makeMsg, validateWorkerMessage, tokensEqual, isPrivateAddress, isLoopbackAddress } from './proto.js';
import { dashboardData, dashboardHtml } from './dashboard.js';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @typedef {{workerId: string, sessionId: string, addr: string, since: string,
 *            lastSeen: number, online: boolean, currentAgent: string|null, taskId: string|null}} WorkerInfo
 * @typedef {{dispatchId: string, role: 'coder'|'tester', msg: Record<string, unknown>,
 *            deliveredAt: number, resolve: (m: any) => void, reject: (e: any) => void,
 *            timer: NodeJS.Timeout|null}} Pending
 */

export class OrchestratorServer extends EventEmitter {
  /**
   * @param {{root: string, remoteCfg: import('./config.js').Config['remote'],
   *          token: string, logger: import('./logger.js').Logger}} opts
   */
  constructor({ root, remoteCfg, token, logger }) {
    super();
    if (!token || token.length < 16) throw new Error('orchestrator token missing or too short');
    this.root = root;
    this.cfg = remoteCfg;
    this.token = token;
    this.log = logger;
    /** @type {WorkerInfo|null} */
    this.worker = null;
    /** @type {Pending|null} */
    this.pending = null;
    /** @type {{res: http.ServerResponse, timer: NodeJS.Timeout}|null} */
    this.waitingPoll = null;
    this.paused = false;
    this.stopQueued = false;
    /** @type {http.Server|null} */
    this.server = null;
    /** @type {NodeJS.Timeout|null} */
    this.offlineTimer = null;
    this.closed = false;
  }

  /** @returns {Promise<number>} the actual listening port */
  listen() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(this.cfg.port, this.cfg.bind, () => {
        const addr = /** @type {import('node:net').AddressInfo} */ (this.server?.address());
        this.offlineTimer = setInterval(() => this.checkOffline(), 500);
        this.offlineTimer.unref?.();
        this.log.info(`[orchestrator] listening on ${this.cfg.bind}:${addr.port}`);
        this.persistWorkers();
        resolve(addr.port);
      });
    });
  }

  close() {
    this.closed = true;
    if (this.offlineTimer) clearInterval(this.offlineTimer);
    if (this.waitingPoll) {
      clearTimeout(this.waitingPoll.timer);
      this.respond(this.waitingPoll.res, 200, makeMsg(MSG.NONE));
      this.waitingPoll = null;
    }
    if (this.pending) this.rejectPending('closed', 'orchestrator shut down');
    this.server?.close();
    this.server?.closeAllConnections?.();
  }

  online() {
    return this.worker != null && this.worker.online;
  }

  workerId() {
    return this.worker?.workerId ?? null;
  }

  /** @param {boolean} p */
  setPaused(p) {
    this.paused = p;
  }

  /** Ask the worker (on its next poll) to kill its running agent. */
  queueStop() {
    this.stopQueued = true;
    this.flushPoll();
  }

  /** @returns {WorkerInfo[]} */
  workersInfo() {
    return this.worker ? [this.worker] : [];
  }

  // ---------- dispatch API (used by RemoteExecutor) ----------

  /**
   * Send RUN_CODER / RUN_TESTER to the worker and wait for its result message.
   * Rejects with Error having .kind = 'offline' | 'timeout' | 'aborted' | 'closed'.
   * @param {'coder'|'tester'} role
   * @param {{taskId: string, prompt: string}} payload
   * @param {{timeoutMs: number, signal?: AbortSignal}} opts
   * @returns {Promise<Record<string, any>>}
   */
  dispatch(role, payload, opts) {
    return new Promise((resolve, reject) => {
      if (this.pending) {
        reject(kindError('busy', 'another dispatch is already pending'));
        return;
      }
      if (!this.online()) {
        reject(kindError('offline', 'no worker online'));
        return;
      }
      const dispatchId = randomUUID();
      const type = role === 'coder' ? MSG.RUN_CODER : MSG.RUN_TESTER;
      const msg = makeMsg(type, { dispatchId, taskId: payload.taskId, prompt: payload.prompt });
      const timer = setTimeout(() => this.rejectPending('timeout', `no result within ${opts.timeoutMs} ms`), opts.timeoutMs);
      timer.unref?.();
      this.pending = { dispatchId, role, msg, deliveredAt: 0, resolve, reject, timer };
      this.log.info(`[orchestrator] dispatching ${type} task=${payload.taskId} dispatch=${dispatchId.slice(0, 8)}`);
      opts.signal?.addEventListener(
        'abort',
        () => {
          this.queueStop();
          this.rejectPending('aborted', 'dispatch aborted');
        },
        { once: true },
      );
      this.flushPoll();
    });
  }

  /** @param {string} kind @param {string} message */
  rejectPending(kind, message) {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.timer) clearTimeout(p.timer);
    this.log.warn(`[orchestrator] dispatch ${p.dispatchId.slice(0, 8)} failed: ${kind} (${message})`);
    p.reject(kindError(kind, message));
  }

  // ---------- HTTP handling ----------

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async handle(req, res) {
    const addr = req.socket.remoteAddress ?? '';
    if (!this.cfg.allowPublicClients && !isPrivateAddress(addr)) {
      this.log.warn(`[orchestrator] rejected non-LAN client ${addr}`);
      this.respond(res, 403, { error: 'clients outside the local network are not allowed' });
      return;
    }
    // Read-only dashboard: no token, but strictly loopback (the PC's own browser).
    if (req.method === 'GET') {
      if (!isLoopbackAddress(addr)) {
        this.respond(res, 403, { error: 'dashboard is available on the orchestrator machine only' });
        return;
      }
      if (req.url === '/dashboard' || req.url === '/dashboard/') {
        const html = dashboardHtml();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
        res.end(html);
      } else if (req.url === '/dashboard/data') {
        this.respond(res, 200, dashboardData(this.root));
      } else {
        this.respond(res, 404, { error: 'unknown endpoint' });
      }
      return;
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!tokensEqual(token, this.token)) {
      this.log.warn(`[orchestrator] rejected unauthenticated request from ${addr}`);
      this.respond(res, 401, { error: 'invalid or missing worker token' });
      return;
    }
    if (req.method !== 'POST') {
      this.respond(res, 405, { error: 'POST only' });
      return;
    }
    /** @type {Record<string, any>} */
    let msg;
    try {
      msg = await readJson(req);
    } catch (err) {
      this.log.warn(`[orchestrator] malformed request from ${addr}: ${/** @type {Error} */ (err).message}`);
      this.respond(res, 400, { error: /** @type {Error} */ (err).message });
      return;
    }
    const invalid = validateWorkerMessage(msg);
    if (invalid) {
      this.log.warn(`[orchestrator] malformed message from ${addr}: ${invalid}`);
      this.respond(res, 400, { error: invalid });
      return;
    }

    switch (req.url) {
      case '/v1/register':
        this.handleRegister(msg, addr, res);
        return;
      case '/v1/poll':
        this.handlePoll(msg, res);
        return;
      case '/v1/heartbeat':
        this.handleHeartbeat(msg, res);
        return;
      case '/v1/result':
        this.handleResult(msg, res);
        return;
      default:
        this.respond(res, 404, { error: 'unknown endpoint' });
    }
  }

  /** @param {Record<string, any>} msg @param {string} addr @param {http.ServerResponse} res */
  handleRegister(msg, addr, res) {
    if (msg.type !== MSG.WORKER_REGISTER) {
      this.respond(res, 400, { error: 'expected WORKER_REGISTER' });
      return;
    }
    if (this.worker && this.worker.online && this.worker.workerId !== msg.workerId) {
      this.log.warn(`[orchestrator] rejected second worker "${msg.workerId}" (already serving "${this.worker.workerId}")`);
      this.respond(res, 409, { error: `another worker (${this.worker.workerId}) is already registered` });
      return;
    }
    const reconnect = this.worker?.workerId === msg.workerId;
    if (this.waitingPoll) {
      // A poll held for the previous session is dead; release it.
      clearTimeout(this.waitingPoll.timer);
      this.respond(this.waitingPoll.res, 200, makeMsg(MSG.NONE));
      this.waitingPoll = null;
    }
    this.worker = {
      workerId: msg.workerId,
      sessionId: randomUUID(),
      addr,
      since: new Date().toISOString(),
      lastSeen: Date.now(),
      online: true,
      currentAgent: null,
      taskId: null,
    };
    this.log.info(`[orchestrator] worker ${msg.workerId} ${reconnect ? 're-registered' : 'registered'} from ${addr}`);
    this.persistWorkers();
    this.emit('worker-online', this.worker.workerId);
    this.respond(res, 200, makeMsg(MSG.REGISTERED, {
      sessionId: this.worker.sessionId,
      heartbeatIntervalMs: this.cfg.heartbeatIntervalMs,
      pollTimeoutMs: this.cfg.pollTimeoutMs,
    }));
  }

  /** @param {Record<string, any>} msg @param {http.ServerResponse} res @returns {boolean} */
  checkSession(msg, res) {
    if (!this.worker || msg.sessionId !== this.worker.sessionId || msg.workerId !== this.worker.workerId) {
      this.respond(res, 403, { error: 'stale or unknown session; re-register' });
      return false;
    }
    return true;
  }

  touch() {
    if (!this.worker) return;
    this.worker.lastSeen = Date.now();
    if (!this.worker.online) {
      this.worker.online = true;
      this.log.info(`[orchestrator] worker ${this.worker.workerId} is back online`);
      this.persistWorkers();
      this.emit('worker-online', this.worker.workerId);
    }
  }

  /** @param {Record<string, any>} msg @param {http.ServerResponse} res */
  handleHeartbeat(msg, res) {
    if (!this.checkSession(msg, res)) return;
    this.touch();
    const w = /** @type {WorkerInfo} */ (this.worker);
    w.currentAgent = typeof msg.currentAgent === 'string' ? msg.currentAgent : null;
    w.taskId = typeof msg.taskId === 'string' ? msg.taskId : null;
    this.persistWorkers();
    this.respond(res, 200, makeMsg(MSG.ACK));
  }

  /** @param {Record<string, any>} msg @param {http.ServerResponse} res */
  handlePoll(msg, res) {
    if (!this.checkSession(msg, res)) return;
    this.touch();
    // Only one held poll at a time; an older lingering poll gets NONE.
    if (this.waitingPoll) {
      clearTimeout(this.waitingPoll.timer);
      this.respond(this.waitingPoll.res, 200, makeMsg(MSG.NONE));
      this.waitingPoll = null;
    }
    const timer = setTimeout(() => {
      if (this.waitingPoll?.res === res) {
        this.waitingPoll = null;
        this.respond(res, 200, makeMsg(this.paused ? MSG.PAUSE : MSG.NONE));
      }
    }, this.cfg.pollTimeoutMs);
    timer.unref?.();
    this.waitingPoll = { res, timer };
    this.flushPoll();
  }

  /** Deliver a queued STOP or the pending command to a waiting poll, if any. */
  flushPoll() {
    const wp = this.waitingPoll;
    if (!wp) return;
    /** @type {Record<string, unknown>|null} */
    let out = null;
    if (this.stopQueued) {
      this.stopQueued = false;
      out = makeMsg(MSG.STOP);
    } else if (this.pending && Date.now() - this.pending.deliveredAt >= this.cfg.redeliverMs) {
      this.pending.deliveredAt = Date.now();
      out = this.pending.msg;
    }
    if (out) {
      clearTimeout(wp.timer);
      this.waitingPoll = null;
      this.respond(wp.res, 200, out);
    }
  }

  /** @param {Record<string, any>} msg @param {http.ServerResponse} res */
  handleResult(msg, res) {
    if (!this.checkSession(msg, res)) return;
    this.touch();
    const resultTypes = [MSG.CODER_RESULT, MSG.TESTER_RESULT, MSG.WORKER_GIT_CONFLICT, MSG.ERROR];
    if (!resultTypes.includes(msg.type)) {
      this.respond(res, 400, { error: `unexpected type ${msg.type} on /v1/result` });
      return;
    }
    const p = this.pending;
    if (p && (msg.dispatchId === p.dispatchId || (msg.type === MSG.ERROR && msg.dispatchId == null))) {
      this.pending = null;
      if (p.timer) clearTimeout(p.timer);
      this.log.info(`[orchestrator] received ${msg.type} for dispatch ${p.dispatchId.slice(0, 8)}`);
      p.resolve(msg);
    } else {
      this.log.warn(`[orchestrator] ignoring stale ${msg.type} (dispatch ${String(msg.dispatchId).slice(0, 8)})`);
    }
    this.respond(res, 200, makeMsg(MSG.ACK));
  }

  // ---------- liveness ----------

  checkOffline() {
    const w = this.worker;
    if (!w || !w.online) return;
    if (Date.now() - w.lastSeen > this.cfg.heartbeatTimeoutMs) {
      w.online = false;
      this.log.warn(`[orchestrator] worker ${w.workerId} OFFLINE (no heartbeat for ${this.cfg.heartbeatTimeoutMs} ms)`);
      this.persistWorkers();
      this.emit('worker-offline', w.workerId);
      if (this.pending) this.rejectPending('offline', `worker ${w.workerId} went offline`);
    }
  }

  /** Persist worker info for the `workers` / `status` CLI commands. */
  persistWorkers() {
    try {
      const file = path.join(this.root, PIPELINE_DIR, 'workers.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const list = this.workersInfo().map((w) => ({
        workerId: w.workerId,
        online: w.online,
        addr: w.addr,
        since: w.since,
        lastSeenAt: new Date(w.lastSeen).toISOString(),
        currentAgent: w.currentAgent,
        taskId: w.taskId,
      }));
      fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), workers: list }, null, 2) + '\n', 'utf8');
    } catch {
      /* observability only; never fatal */
    }
  }

  /** @param {http.ServerResponse} res @param {number} code @param {unknown} body */
  respond(res, code, body) {
    if (res.writableEnded) return;
    const data = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
}

/** @param {string} kind @param {string} message */
function kindError(kind, message) {
  const err = /** @type {Error & {kind: string}} */ (new Error(message));
  err.kind = kind;
  return err;
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<Record<string, any>>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}
