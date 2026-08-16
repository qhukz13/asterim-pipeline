// Worker: an execution node, not an orchestrator.
//
// Connects out to the orchestrator over the LAN, registers with the shared
// token, long-polls for commands, runs Claude coder/tester locally via the
// existing agents.js machinery, and reports structured results back. It
// holds NO pipeline state, makes no architectural decisions, and never
// creates tasks. Duplicate command deliveries are deduplicated by
// dispatchId, so a re-offered RUN_CODER never launches a second coder.
//
// Git flow per command (repository sync stays in git, never over the LAN):
//   coder : pull --ff-only -> run -> (agent commits) -> push
//   tester: pull --ff-only -> run tests -> report content returned
// A non-fast-forward pull or rejected push produces WORKER_GIT_CONFLICT and
// the orchestrator enters a human gate. No destructive git command is ever
// used.

import { MSG, makeMsg, capReport } from './proto.js';
import { parseTaskFile, sha256 } from './parse.js';
import { runAgent, killTree } from './agents.js';
import * as gitx from './git.js';
import fs from 'node:fs';
import path from 'node:path';

const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 15000;
const RESULT_RETRY_MS = 2000;
const HEARTBEAT_FAILURES_BEFORE_RECONNECT = 3;

export class Worker {
  /**
   * @param {{root: string, host: string, port: number, token: string, workerId: string,
   *          agents: import('./config.js').Config['agents'],
   *          files: import('./config.js').Config['files'],
   *          logger: import('./logger.js').Logger,
   *          failureOutput?: {enabled: boolean, chars: number}}} opts
   */
  constructor({ root, host, port, token, workerId, agents, files, logger, failureOutput }) {
    this.root = root;
    this.base = `http://${host}:${port}`;
    this.token = token;
    this.workerId = workerId;
    this.agents = agents;
    this.files = files;
    this.log = logger;
    /** On failure only: how much agent output may be sent back (0 = none). */
    this.failureOutputChars = failureOutput?.enabled === false ? 0 : (failureOutput?.chars ?? 2000);
    /** @type {string|null} */
    this.sessionId = null;
    this.heartbeatIntervalMs = 10000;
    this.pollTimeoutMs = 25000;
    /** @type {NodeJS.Timeout|null} */
    this.heartbeatTimer = null;
    this.heartbeatFailures = 0;
    /** @type {{dispatchId: string, role: 'coder'|'tester', taskId: string, pid: number|null}|null} */
    this.current = null;
    /** @type {Map<string, Record<string, unknown>>} dispatchId -> result (bounded) */
    this.completed = new Map();
    /** @type {Record<string, unknown>[]} results not yet delivered */
    this.resultQueue = [];
    this.stopped = false;
    /** @type {AbortController|null} */
    this.pollAbort = null;
    this.pausedLogged = false;
  }

  /** Main loop: (re)connect forever until stop(). */
  async run() {
    let backoff = BACKOFF_MIN_MS;
    this.log.info(`[worker] ${this.workerId} connecting to ${this.base}`);
    while (!this.stopped) {
      try {
        await this.register();
        backoff = BACKOFF_MIN_MS;
        this.startHeartbeat();
        await this.flushResults();
        await this.pollLoop();
      } catch (err) {
        if (!this.stopped) {
          this.log.warn(`[worker] connection lost: ${/** @type {Error} */ (err).message}; retrying in ${backoff} ms`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
      } finally {
        this.stopHeartbeat();
      }
    }
  }

  stop() {
    this.stopped = true;
    this.stopHeartbeat();
    this.pollAbort?.abort();
    if (this.current?.pid != null) {
      this.log.warn(`[worker] stopping: killing running ${this.current.role} (pid ${this.current.pid})`);
      killTree(this.current.pid);
    }
  }

  // ---------- transport ----------

  /**
   * @param {string} pathName
   * @param {Record<string, unknown>} msg
   * @param {number} [timeoutMs]
   * @returns {Promise<Record<string, any>>}
   */
  async request(pathName, msg, timeoutMs = 10000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(this.base + pathName, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
        body: JSON.stringify(msg),
        signal: ctl.signal,
      });
      const body = /** @type {Record<string, any>} */ (await res.json().catch(() => ({})));
      if (res.status === 401) throw new Error('authentication rejected (check the worker token)');
      if (res.status === 403) throw new Error(`session rejected: ${body.error ?? res.status}`);
      if (!res.ok) throw new Error(`${pathName} -> HTTP ${res.status}: ${body.error ?? ''}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async register() {
    const reply = await this.request('/v1/register', makeMsg(MSG.WORKER_REGISTER, { workerId: this.workerId }));
    if (reply.type !== MSG.REGISTERED || typeof reply.sessionId !== 'string') {
      throw new Error('unexpected register response');
    }
    this.sessionId = reply.sessionId;
    if (typeof reply.heartbeatIntervalMs === 'number') this.heartbeatIntervalMs = reply.heartbeatIntervalMs;
    if (typeof reply.pollTimeoutMs === 'number') this.pollTimeoutMs = reply.pollTimeoutMs;
    this.heartbeatFailures = 0;
    this.log.info(`[worker] registered (session ${this.sessionId.slice(0, 8)})`);
  }

  /** @param {Record<string, unknown>} [extra] */
  envelope(extra = {}) {
    return { workerId: this.workerId, sessionId: this.sessionId ?? '', ...extra };
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async heartbeat() {
    try {
      await this.request(
        '/v1/heartbeat',
        makeMsg(MSG.WORKER_HEARTBEAT, this.envelope({
          currentAgent: this.current?.role ?? null,
          taskId: this.current?.taskId ?? null,
        })),
      );
      this.heartbeatFailures = 0;
    } catch {
      this.heartbeatFailures += 1;
      if (this.heartbeatFailures >= HEARTBEAT_FAILURES_BEFORE_RECONNECT) {
        // Force the poll loop to fail so run() re-registers. The running
        // agent (if any) is left alone and its result is queued for delivery.
        this.pollAbort?.abort();
      }
    }
  }

  // ---------- command handling ----------

  async pollLoop() {
    while (!this.stopped) {
      if (this.resultQueue.length > 0) await this.flushResults();
      this.pollAbort = new AbortController();
      /** @type {Record<string, any>} */
      let cmd;
      try {
        const ctl = this.pollAbort;
        const timer = setTimeout(() => ctl.abort(), this.pollTimeoutMs + 10000);
        try {
          const res = await fetch(this.base + '/v1/poll', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
            body: JSON.stringify(makeMsg(MSG.WORKER_POLL, this.envelope())),
            signal: ctl.signal,
          });
          const body = /** @type {Record<string, any>} */ (await res.json().catch(() => ({})));
          if (res.status === 401 || res.status === 403) throw new Error(`poll rejected: ${body.error ?? res.status}`);
          if (!res.ok) throw new Error(`poll -> HTTP ${res.status}`);
          cmd = body;
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (this.stopped) return;
        throw err instanceof Error ? err : new Error(String(err));
      }
      await this.handleCommand(cmd);
    }
  }

  /** @param {Record<string, any>} cmd */
  async handleCommand(cmd) {
    switch (cmd.type) {
      case MSG.NONE:
        this.pausedLogged = false;
        return;
      case MSG.PAUSE:
        if (!this.pausedLogged) {
          this.log.info('[worker] orchestrator is paused');
          this.pausedLogged = true;
        }
        await sleep(1000);
        return;
      case MSG.STOP:
        if (this.current?.pid != null) {
          this.log.warn(`[worker] STOP received: killing running ${this.current.role}`);
          killTree(this.current.pid);
        } else {
          this.log.info('[worker] STOP received (no agent running)');
        }
        return;
      case MSG.RUN_CODER:
      case MSG.RUN_TESTER: {
        const role = cmd.type === MSG.RUN_CODER ? 'coder' : 'tester';
        if (typeof cmd.dispatchId !== 'string' || typeof cmd.taskId !== 'string' || typeof cmd.prompt !== 'string') {
          this.log.warn(`[worker] ignoring malformed ${cmd.type}`);
          return;
        }
        if (this.current) {
          if (this.current.dispatchId === cmd.dispatchId) return; // duplicate of the run in progress
          this.log.warn(`[worker] busy with ${this.current.dispatchId.slice(0, 8)}; refusing ${cmd.dispatchId.slice(0, 8)}`);
          await this.sendResult(makeMsg(MSG.ERROR, this.envelope({
            dispatchId: cmd.dispatchId,
            message: `worker is busy running ${this.current.role} for task ${this.current.taskId}`,
          })));
          return;
        }
        const cached = this.completed.get(cmd.dispatchId);
        if (cached) {
          this.log.info(`[worker] re-sending cached result for dispatch ${cmd.dispatchId.slice(0, 8)}`);
          await this.sendResult({ ...cached, sessionId: this.sessionId });
          return;
        }
        // Run WITHOUT awaiting so polling continues during execution: STOP
        // can then interrupt a running agent, and duplicate deliveries of
        // this dispatch are absorbed by the `current` check above.
        void this.execute(role, { dispatchId: cmd.dispatchId, taskId: cmd.taskId, prompt: cmd.prompt });
        return;
      }
      default:
        this.log.warn(`[worker] ignoring unknown command type ${String(cmd.type)}`);
    }
  }

  /**
   * @param {'coder'|'tester'} role
   * @param {{dispatchId: string, taskId: string, prompt: string}} cmd
   */
  async execute(role, cmd) {
    this.current = { dispatchId: cmd.dispatchId, role, taskId: cmd.taskId, pid: null };
    this.log.info(`[worker] [${role}] starting task ${cmd.taskId} (dispatch ${cmd.dispatchId.slice(0, 8)})`);
    /** @type {Record<string, unknown>} */
    let result;
    try {
      result = await this.executeInner(role, cmd);
    } catch (err) {
      result = makeMsg(MSG.ERROR, this.envelope({
        dispatchId: cmd.dispatchId,
        message: `worker error while running ${role}: ${/** @type {Error} */ (err).message}`,
      }));
    }
    this.current = null;
    this.remember(cmd.dispatchId, result);
    await this.sendResult(result);
  }

  /**
   * @param {'coder'|'tester'} role
   * @param {{dispatchId: string, taskId: string, prompt: string}} cmd
   * @returns {Promise<Record<string, unknown>>}
   */
  async executeInner(role, cmd) {
    if (!gitx.isRepo(this.root)) {
      return makeMsg(MSG.ERROR, this.envelope({
        dispatchId: cmd.dispatchId,
        message: `worker root ${this.root} is not a git repository`,
      }));
    }
    const pull = gitx.pullFfOnly(this.root);
    if (!pull.ok) {
      this.log.warn(`[worker] git pull --ff-only failed: ${pull.stderr}`);
      return makeMsg(MSG.WORKER_GIT_CONFLICT, this.envelope({
        dispatchId: cmd.dispatchId,
        taskId: cmd.taskId,
        stage: 'pull',
        detail: (pull.stderr || pull.stdout).slice(0, 2000),
      }));
    }
    const taskAbs = path.resolve(this.root, this.files.task);
    const task = parseTaskFile(fs.existsSync(taskAbs) ? fs.readFileSync(taskAbs, 'utf8') : null);
    if (!task.valid || task.taskId !== cmd.taskId) {
      return makeMsg(MSG.ERROR, this.envelope({
        dispatchId: cmd.dispatchId,
        message: `task file on worker (${task.taskId ?? 'none'}) does not match dispatched task ${cmd.taskId}; repository may be out of sync`,
      }));
    }

    // The report this run is expected to (re)write, as it stands beforehand.
    const reportRel = role === 'coder' ? this.files.coderReport : this.files.testReport;
    const reportAbs = path.resolve(this.root, reportRel);
    const readReport = () => (fs.existsSync(reportAbs) ? fs.readFileSync(reportAbs, 'utf8') : null);
    const beforeText = readReport();
    const beforeHash = beforeText == null ? null : sha256(beforeText);

    const preSha = role === 'coder' ? gitx.headSha(this.root) : null;
    const res = await runAgent(role, this.agents[role], cmd.prompt, this.root, {
      onSpawn: (pid) => {
        if (this.current) this.current.pid = pid;
        this.log.info(`[worker] [${role}] running (pid ${pid})`);
      },
      // Stream the agent's output live to the worker terminal (it is also
      // captured to .pipeline/logs/<role>-*.log). Stays on this machine.
      onOutput: (chunk) => process.stdout.write(chunk),
    });
    if (this.current) this.current.pid = null;
    this.log.info(
      res.spawnError
        ? `[worker] [${role}] failed to launch: ${res.spawnError}`
        : `[worker] [${role}] exited code=${res.code}${res.timedOut ? ' (timed out)' : ''} log=${path.relative(this.root, res.logFile)}`,
    );

    // Detect the classic headless failure here, on the machine that ran the
    // agent, so the human gate can name the cause and the log to open
    // instead of just reporting a stale report downstream.
    const afterText = readReport();
    const afterHash = afterText == null ? null : sha256(afterText);
    if (afterHash == null || afterHash === beforeHash) {
      const workerLog = path.relative(this.root, res.logFile);
      const what = afterHash == null
        ? `did not create ${reportRel}`
        : `did not modify ${reportRel} (it still holds the previous content)`;
      this.log.warn(`[worker] [${role}] ${what}`);
      const tail = this.tailOf(res.logFile);
      if (tail) {
        // Make the reason obvious on the worker's own terminal too.
        this.log.warn(`[worker] [${role}] last output follows:\n${'-'.repeat(60)}\n${tail}\n${'-'.repeat(60)}`);
      }
      return makeMsg(MSG.ERROR, this.envelope({
        dispatchId: cmd.dispatchId,
        message:
          `the ${role} exited (code ${res.code}) but ${what} in the worker clone at ${this.root}. ` +
          'This usually means the agent was denied permission to write the file in headless mode. ' +
          `Full agent output is on the worker at ${workerLog}.`,
        outputTail: tail,
      }));
    }

    let committed = false;
    let pushed = false;
    if (role === 'coder' && !res.spawnError && !res.timedOut) {
      committed = gitx.headSha(this.root) !== preSha;
      if (committed) {
        const p = gitx.push(this.root); // plain push, never force
        if (!p.ok) {
          this.log.warn(`[worker] git push failed: ${p.stderr}`);
          return makeMsg(MSG.WORKER_GIT_CONFLICT, this.envelope({
            dispatchId: cmd.dispatchId,
            taskId: cmd.taskId,
            stage: 'push',
            detail: (p.stderr || p.stdout).slice(0, 2000),
          }));
        }
        pushed = true;
      }
    }

    // Only the protocol report file travels over the LAN — never source
    // code, transcripts, or environment data.
    const reportContent = capReport(afterText);

    return makeMsg(role === 'coder' ? MSG.CODER_RESULT : MSG.TESTER_RESULT, this.envelope({
      dispatchId: cmd.dispatchId,
      taskId: cmd.taskId,
      exitCode: res.code,
      timedOut: res.timedOut,
      spawnError: res.spawnError,
      // Only when something went wrong; a clean run sends no output.
      outputTail: res.spawnError || res.timedOut ? this.tailOf(res.logFile) : null,
      committed,
      pushed,
      reportContent,
    }));
  }

  /**
   * Tail of an agent log, for FAILED runs only. Successful runs never send
   * output anywhere; this is bounded and can be disabled entirely with
   * remote.includeFailureOutput = false.
   * @param {string} logFile
   * @returns {string|null}
   */
  tailOf(logFile) {
    if (this.failureOutputChars <= 0) return null;
    try {
      const text = fs.readFileSync(logFile, 'utf8');
      const trimmed = text.length > this.failureOutputChars ? text.slice(-this.failureOutputChars) : text;
      return trimmed.trim() === '' ? null : (text.length > this.failureOutputChars ? '…' : '') + trimmed;
    } catch {
      return null;
    }
  }

  /** @param {string} dispatchId @param {Record<string, unknown>} result */
  remember(dispatchId, result) {
    this.completed.set(dispatchId, result);
    while (this.completed.size > 20) {
      const oldest = this.completed.keys().next().value;
      if (oldest == null) break;
      this.completed.delete(oldest);
    }
  }

  /**
   * Deliver a result, queueing and retrying across reconnects: results must
   * not be lost to a transient network failure.
   * @param {Record<string, unknown>} result
   */
  async sendResult(result) {
    this.resultQueue.push(result);
    await this.flushResults();
  }

  async flushResults() {
    while (this.resultQueue.length > 0 && !this.stopped) {
      const msg = { ...this.resultQueue[0], sessionId: this.sessionId ?? '' };
      try {
        await this.request('/v1/result', msg);
        this.resultQueue.shift();
      } catch (err) {
        this.log.warn(`[worker] could not deliver result (${/** @type {Error} */ (err).message}); will retry`);
        await sleep(RESULT_RETRY_MS);
        return; // let the reconnect/poll cycle try again with a fresh session
      }
    }
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
