// RemoteExecutor: the orchestrator-side bridge between the existing Runner
// and the LAN server. The Runner keeps owning the state machine, gates, and
// validation; this class only (a) moves the task protocol files through git,
// (b) dispatches coder/tester execution to the worker, and (c) normalizes
// worker results into the AgentResult shape the Runner already validates.

import fs from 'node:fs';
import path from 'node:path';
import { git, pullFfOnly, push } from './git.js';

/**
 * @typedef {import('./agents.js').AgentResult & {
 *   workerOffline?: boolean, dispatchTimeout?: boolean, remoteError?: string|null,
 *   gitConflict?: {stage: string, detail: string}|null, reportContent?: string|null,
 *   committed?: boolean, pushed?: boolean,
 * }} RemoteAgentResult
 */

export class RemoteExecutor {
  /**
   * @param {import('./server.js').OrchestratorServer} server
   * @param {{root: string, cfg: import('./config.js').Config, logger: import('./logger.js').Logger}} opts
   */
  constructor(server, { root, cfg, logger }) {
    this.server = server;
    this.root = root;
    this.cfg = cfg;
    this.log = logger;
  }

  online() {
    return this.server.online();
  }

  workerId() {
    return this.server.workerId() ?? '(none)';
  }

  /** @param {() => void} cb invoked on worker online/offline transitions */
  onStateChange(cb) {
    this.server.on('worker-online', cb);
    this.server.on('worker-offline', cb);
  }

  /** @param {boolean} p */
  setPaused(p) {
    this.server.setPaused(p);
  }

  /**
   * Make sure the task protocol files (tasks/current.md, test/current.md)
   * are committed and pushed so the worker's `git pull --ff-only` sees them.
   * Additive only: commits just those two paths, plain push, never force.
   * @param {string} taskId
   * @returns {{ok: boolean, error?: string}}
   */
  publishTaskFiles(taskId) {
    const rels = [this.cfg.files.task, this.cfg.files.testSpec].filter((rel) =>
      fs.existsSync(path.resolve(this.root, rel)),
    );
    const status = git(this.root, ['status', '--porcelain', '--', ...rels]);
    if (!status.ok) return { ok: false, error: `git status failed: ${status.stderr}` };
    if (status.stdout !== '') {
      if (!this.cfg.remote.autoCommitTaskFiles) {
        return {
          ok: false,
          error: 'task protocol files have uncommitted changes and remote.autoCommitTaskFiles is disabled; commit them manually',
        };
      }
      const add = git(this.root, ['add', '--', ...rels]);
      if (!add.ok) return { ok: false, error: `git add failed: ${add.stderr}` };
      const commit = git(this.root, ['commit', '-m', `pipeline: dispatch task ${taskId}`, '--', ...rels]);
      if (!commit.ok) return { ok: false, error: `git commit failed: ${commit.stderr || commit.stdout}` };
      this.log.info(`[orchestrator] committed task files for ${taskId}`);
    }
    const p = push(this.root);
    if (!p.ok) return { ok: false, error: `git push failed: ${p.stderr || p.stdout}` };
    return { ok: true };
  }

  /**
   * Dispatch an agent run to the worker and wait for the result.
   * @param {'coder'|'tester'} role
   * @param {string} prompt
   * @param {string} taskId
   * @param {AbortSignal} signal
   * @param {number} timeoutMinutes the agent timeout configured for this role
   * @returns {Promise<RemoteAgentResult>}
   */
  async runAgent(role, prompt, taskId, signal, timeoutMinutes) {
    /** @type {RemoteAgentResult} */
    const base = {
      code: null, timedOut: false, spawnError: null, pid: null, logFile: '(on worker)',
      workerOffline: false, dispatchTimeout: false, remoteError: null, gitConflict: null,
      reportContent: null, committed: false, pushed: false,
    };
    const agentMs = timeoutMinutes > 0 ? timeoutMinutes * 60_000 : 6 * 3_600_000;
    const timeoutMs = agentMs + this.cfg.remote.dispatchGraceMinutes * 60_000;
    /** @type {Record<string, any>} */
    let msg;
    try {
      msg = await this.server.dispatch(role, { taskId, prompt }, { timeoutMs, signal });
    } catch (err) {
      const kind = /** @type {{kind?: string, message: string}} */ (err).kind;
      if (kind === 'offline') return { ...base, workerOffline: true };
      if (kind === 'timeout') return { ...base, dispatchTimeout: true };
      if (kind === 'aborted') return base; // runner's stopRequested path takes over
      return { ...base, remoteError: /** @type {Error} */ (err).message };
    }
    switch (msg.type) {
      case 'WORKER_GIT_CONFLICT':
        return { ...base, gitConflict: { stage: String(msg.stage), detail: String(msg.detail ?? '') } };
      case 'ERROR':
        return { ...base, remoteError: String(msg.message) };
      default: // CODER_RESULT / TESTER_RESULT
        return {
          ...base,
          code: typeof msg.exitCode === 'number' ? msg.exitCode : null,
          timedOut: msg.timedOut === true,
          spawnError: typeof msg.spawnError === 'string' ? msg.spawnError : null,
          reportContent: typeof msg.reportContent === 'string' ? msg.reportContent : null,
          committed: msg.committed === true,
          pushed: msg.pushed === true,
        };
    }
  }

  /**
   * Bring the worker's output onto the orchestrator: pull pushed commits
   * (coder only) and materialize the report content received over the LAN.
   * @param {'coder'|'tester'} role
   * @param {RemoteAgentResult} res
   * @returns {{ok: boolean, error?: string}}
   */
  syncAfterRemote(role, res) {
    if (role === 'coder') {
      const pull = pullFfOnly(this.root);
      if (!pull.ok) return { ok: false, error: `git pull --ff-only failed after coder run: ${pull.stderr || pull.stdout}` };
    }
    if (res.reportContent != null) {
      const rel = role === 'coder' ? this.cfg.files.coderReport : this.cfg.files.testReport;
      const abs = path.resolve(this.root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, res.reportContent, 'utf8');
    }
    return { ok: true };
  }
}
