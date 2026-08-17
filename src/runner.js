// The pipeline runner: a single deterministic loop.
//
//   ORCHESTRATOR -> tasks/current.md -> CODER -> reports/current.md
//     -> TESTER -> test/report.md -> ORCHESTRATOR -> next task -> ...
//
// The loop is intentionally sequential: at most one agent runs at a time,
// every step validates the protocol files it depends on, and anything
// ambiguous stops the pipeline at a human gate instead of guessing.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PIPELINE_DIR } from './config.js';
import { AGENT_STATES, assertTransition } from './state-machine.js';
import { parseTaskFile, parseCoderReport, parseTestReport, parseTestSpec, sha256 } from './parse.js';
import { readState, writeState, HISTORY_LIMIT } from './store.js';
import { FileWatcher } from './watch.js';
import { runAgent, renderPrompt, pidAlive } from './agents.js';
import { acquireLock, releaseLock, consumeControl } from './control.js';
import * as gitx from './git.js';

const SAFETY_TICK_MS = 5000;

/**
 * Gate detail lines carrying the agent's own last words, when the worker
 * sent them (failed runs only).
 * @param {import('./remote.js').RemoteAgentResult} res
 * @returns {string[]}
 */
function agentOutputDetail(res) {
  let tail = res.outputTail ?? null;
  if (tail == null && typeof res.logFileLocal === 'string') {
    try {
      const text = fs.readFileSync(res.logFileLocal, 'utf8');
      tail = text.length > 2000 ? '…' + text.slice(-2000) : text;
      if (tail.trim() === '') tail = null;
    } catch {
      tail = null;
    }
  }
  if (!tail) return [];
  return ['', 'Last output from the agent:', '-'.repeat(50), ...tail.split(/\r?\n/), '-'.repeat(50)];
}

export class Runner extends EventEmitter {
  /**
   * @param {{root: string, config: import('./config.js').Config, logger: import('./logger.js').Logger,
   *          remote?: import('./remote.js').RemoteExecutor|null,
   *          bus?: import('./output-bus.js').OutputBus|null}} opts
   */
  constructor({ root, config, logger, remote = null, bus = null }) {
    super();
    this.root = root;
    this.cfg = config;
    this.log = logger;
    /** When set, coder/tester execution is dispatched to the LAN worker. */
    this.remote = remote;
    /** Shared dashboard output feed, when a dashboard is being served. */
    this.bus = bus;
    /** Set after a resumed gate: ask the orchestrator for the next step. */
    this.planRequested = false;
    this.waitingForWorkerLogged = false;
    /** @type {import('./store.js').PersistedState} */
    this.st = readState(root).state;
    this.stopRequested = false;
    this.resumeRequested = false;
    this.runOnce = false;
    /** @type {(() => void)|null} */
    this.wakeResolve = null;
    /** @type {AbortController|null} */
    this.agentAbort = null;
    /** @type {FileWatcher|null} */
    this.watcher = null;
    /** @type {fs.FSWatcher|null} */
    this.ctrlWatcher = null;
    /** @type {NodeJS.Timeout|null} */
    this.tick = null;
    /** exit summary for the CLI @type {{ok: boolean, gated: boolean, message: string}} */
    this.exitInfo = { ok: true, gated: false, message: 'stopped' };
  }

  // ---------- protocol file access ----------

  /** @param {'task'|'coderReport'|'testSpec'|'testReport'} key */
  readProto(key) {
    const abs = path.resolve(this.root, this.cfg.files[key]);
    try {
      const text = fs.readFileSync(abs, 'utf8');
      return { text, hash: sha256(text) };
    } catch {
      return { text: null, hash: null };
    }
  }

  save() {
    writeState(this.root, this.st);
  }

  /**
   * Variables available to every prompt template. The protocol paths come
   * from config so an agent can never be told to use a path the pipeline
   * does not watch.
   * @param {Record<string, string>} [extra]
   */
  promptVars(extra = {}) {
    return {
      taskId: this.st.taskId ?? '',
      taskFile: this.cfg.files.task,
      coderReportFile: this.cfg.files.coderReport,
      testSpecFile: this.cfg.files.testSpec,
      testReportFile: this.cfg.files.testReport,
      roadmapFile: this.cfg.files.roadmap,
      ...extra,
    };
  }

  /**
   * The orchestrator prompt, plus the roadmap planning discipline when a
   * roadmap is configured.
   */
  orchestratorPrompt() {
    const base = this.cfg.prompts.orchestrator;
    return this.cfg.files.roadmap ? `${base}\n${this.cfg.prompts.orchestratorRoadmap}` : base;
  }

  /**
   * Fold the current task attempt into the history ring. Upserts on
   * taskId+startedAt, so a task that gates and is then resumed stays one row
   * whose outcome reflects how it actually ended.
   * @param {string} outcome
   */
  recordHistory(outcome) {
    const s = this.st;
    if (s.taskId == null) return;
    /** @type {import('./store.js').HistoryEntry} */
    const entry = {
      taskId: s.taskId,
      phase: s.phase,
      startedAt: s.startedAt,
      endedAt: new Date().toISOString(),
      coderStatus: s.lastCoderStatus,
      testResult: s.lastTestResult,
      coderMs: s.timings.coderMs,
      testerMs: s.timings.testerMs,
      orchestratorMs: s.timings.orchestratorMs,
      outcome,
    };
    const last = s.history[s.history.length - 1];
    if (last && last.taskId === entry.taskId && last.startedAt === entry.startedAt) {
      s.history[s.history.length - 1] = entry;
    } else {
      s.history.push(entry);
      if (s.history.length > HISTORY_LIMIT) s.history.splice(0, s.history.length - HISTORY_LIMIT);
    }
    this.save();
  }

  /** Zero the per-task timers when a new task begins. */
  resetTimings() {
    this.st.timings = { coderMs: 0, testerMs: 0, orchestratorMs: 0 };
  }

  /** @param {import('./state-machine.js').PipelineState} to */
  setState(to) {
    const from = this.st.state;
    assertTransition(from, to);
    this.st.state = to;
    this.save();
    this.log.info(`state ${from} -> ${to}`);
    this.emit('transition', { from, to });
  }

  // ---------- lifecycle ----------

  /**
   * @param {{once?: boolean}} [opts]
   */
  async start(opts = {}) {
    this.runOnce = opts.once ?? false;
    acquireLock(this.root);
    try {
      this.ensureDirs();
      const { corrupt } = readState(this.root);
      this.st = readState(this.root).state;
      this.log.info(`pipeline starting (root=${this.root}${this.runOnce ? ', run-once' : ''})`);

      this.watcher = new FileWatcher(
        this.root,
        Object.values(this.cfg.files),
        this.cfg.watchDebounceMs,
        (rel) => {
          this.log.info(`file settled: ${rel}`);
          this.wake();
        },
      );
      this.watcher.start();
      this.startControlChannel();
      this.remote?.onStateChange(() => this.wake());
      this.remote?.setPaused(this.st.paused);
      const onSigint = () => this.requestStop('SIGINT');
      process.on('SIGINT', onSigint);

      try {
        if (corrupt) {
          this.gate('State file .pipeline/state.json is corrupt or unreadable.', [
            'The previous pipeline state could not be recovered safely.',
            'Inspect the repository and delete .pipeline/state.json to start fresh.',
          ]);
        } else {
          this.recover();
        }
        await this.runLoop();
      } finally {
        process.removeListener('SIGINT', onSigint);
        this.watcher?.close();
        this.ctrlWatcher?.close();
        if (this.tick) clearInterval(this.tick);
        this.save();
      }
      this.log.info('pipeline stopped');
    } finally {
      releaseLock(this.root);
    }
    return this.exitInfo;
  }

  ensureDirs() {
    for (const rel of Object.values(this.cfg.files)) {
      fs.mkdirSync(path.dirname(path.resolve(this.root, rel)), { recursive: true });
    }
    fs.mkdirSync(path.join(this.root, PIPELINE_DIR), { recursive: true });
  }

  startControlChannel() {
    const dir = path.join(this.root, PIPELINE_DIR);
    try {
      this.ctrlWatcher = fs.watch(dir, (_e, filename) => {
        if (filename && String(filename).toLowerCase() === 'control.json') this.processControl();
      });
      this.ctrlWatcher.on('error', () => {});
    } catch {
      /* safety tick still polls */
    }
    this.tick = setInterval(() => {
      this.processControl();
      this.wake();
    }, SAFETY_TICK_MS);
    // Don't let the safety tick keep the process alive on its own.
    this.tick.unref?.();
  }

  processControl() {
    const cmd = consumeControl(this.root);
    if (!cmd) return;
    this.log.info(`control command: ${cmd}`);
    if (cmd === 'pause') {
      this.st.paused = true;
      this.save();
      this.remote?.setPaused(true);
    } else if (cmd === 'resume') {
      this.st.paused = false;
      this.resumeRequested = true;
      this.save();
      this.remote?.setPaused(false);
    } else if (cmd === 'stop') {
      this.requestStop('stop command');
    }
    this.wake();
  }

  /** @param {string} why */
  requestStop(why) {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.log.info(`stop requested (${why})`);
    this.agentAbort?.abort();
    this.wake();
  }

  wake() {
    const r = this.wakeResolve;
    this.wakeResolve = null;
    r?.();
  }

  waitForWake() {
    return new Promise((resolve) => {
      this.wakeResolve = /** @type {() => void} */ (resolve);
    });
  }

  // ---------- recovery ----------

  recover() {
    const s = this.st;
    const agentRole = /** @type {Record<string, 'coder'|'tester'|'orchestrator'>} */ (AGENT_STATES)[s.state];
    if (agentRole || s.interrupted) {
      const role = agentRole ?? 'an agent';
      const pid = agentRole ? s[`${agentRole}Pid`] : null;
      if (pid != null && pidAlive(pid)) {
        this.gate(`Previous ${role} process (pid ${pid}) appears to STILL be running.`, [
          `The pipeline was restarted while task ${s.taskId ?? '?'} was in state ${s.state}.`,
          'Wait for or terminate that process, verify the repository state, then resume.',
        ]);
      } else {
        this.gate(`Pipeline previously stopped while ${role} was running (state ${s.state}).`, [
          `Task ${s.taskId ?? '?'} may be half-finished. The task will NOT be restarted automatically.`,
          'Review the repository and git state. Resuming will re-evaluate the protocol files',
          `and may re-launch the ${role} for the same task.`,
        ]);
      }
      s.interrupted = false;
      s.coderPid = s.testerPid = s.orchestratorPid = null;
      this.save();
      return;
    }
    if (s.state === 'HUMAN_GATE' || s.state === 'FAILED') {
      this.log.warn(`resuming in ${s.state}: ${s.gateReason ?? '(no reason recorded)'} — run "asterim-pipeline resume" after review`);
      return;
    }
    if (s.state === 'BLOCKED') {
      this.log.info('recovered in BLOCKED; orchestrator will be invoked');
      return;
    }
    this.rescan(false);
  }

  /**
   * Determine the pipeline state purely from protocol file contents.
   * Used at first start and after a human "resume".
   * @param {boolean} afterResume
   */
  rescan(afterResume) {
    const s = this.st;
    if (this.remote && this.cfg.git.enabled && gitx.isRepo(this.root)) {
      // In distributed mode the worker may have pushed work while we were
      // down or gated; the protocol files are only trustworthy after a pull.
      const pull = gitx.pullFfOnly(this.root);
      if (!pull.ok) {
        this.gate('git pull --ff-only failed while re-evaluating the pipeline state.', [
          (pull.stderr || pull.stdout).slice(0, 500),
          'Resolve the git state manually, then run "asterim-pipeline resume".',
        ]);
        return;
      }
    }
    const taskF = this.readProto('task');
    const task = parseTaskFile(taskF.text);
    // Re-derivation from file contents, not a runtime transition: the state
    // machine table does not apply here (e.g. a resume may land straight on
    // TEST_REPORT_READY), so assign directly instead of using setState().
    const set = (/** @type {import('./state-machine.js').PipelineState} */ to) => {
      const from = s.state;
      s.state = to;
      this.save();
      if (from !== to) {
        this.log.info(`state ${from} -> ${to} (rescan)`);
        this.emit('transition', { from, to });
      }
    };

    if (!task.valid) {
      this.log.info('no valid task in ' + this.cfg.files.task + '; waiting');
      set('IDLE');
      return;
    }
    if (task.phaseComplete) {
      if (afterResume || taskF.hash === s.hashes.task) {
        // Phase-complete already acknowledged; wait for a new task.
        s.hashes.task = taskF.hash;
        this.log.info('phase-complete acknowledged; waiting for next task');
        set('IDLE');
      } else {
        s.hashes.task = taskF.hash;
        this.phaseCompleteGate(task);
      }
      return;
    }

    s.hashes.task = taskF.hash;
    if (task.taskId !== s.taskId) {
      s.taskId = task.taskId;
      s.phase = task.phase ?? s.phase;
      s.startedAt = new Date().toISOString();
      s.consecutiveBlocked = 0;
    }

    const repF = this.readProto('coderReport');
    const rep = parseCoderReport(repF.text);
    if (!rep.valid || rep.taskId !== task.taskId) {
      set('TASK_READY');
      return;
    }
    s.lastCoderStatus = rep.status;
    s.hashes.coderReport = repF.hash;
    if (rep.status === 'BLOCKED' || rep.status === 'FAILED') {
      set('BLOCKED');
      return;
    }
    const testF = this.readProto('testReport');
    const test = parseTestReport(testF.text);
    if (test.valid && test.taskId === task.taskId) {
      s.lastTestResult = test.result;
      s.hashes.testReport = testF.hash;
      set('TEST_REPORT_READY');
      return;
    }
    set('CODE_REPORT_READY');
  }

  // ---------- main loop ----------

  async runLoop() {
    while (!this.stopRequested) {
      this.processControl();
      if (this.stopRequested) break;
      try {
        const done = await this.stepOnce();
        if (done) break;
      } catch (err) {
        this.gate(`Unexpected pipeline error: ${/** @type {Error} */ (err).message}`, [
          'The pipeline cannot determine the next state safely.',
        ]);
      }
    }
  }

  /**
   * Execute one decision of the loop. Returns true when the loop should end.
   * @returns {Promise<boolean>}
   */
  async stepOnce() {
    const s = this.st;

    if (s.state === 'HUMAN_GATE' || s.state === 'FAILED') {
      if (this.resumeRequested) {
        this.resumeRequested = false;
        this.log.info('human resume received; re-evaluating protocol files');
        // A resumed gate is the human saying "carry on", so let the
        // orchestrator plan the next step rather than idling for a
        // hand-written task file.
        this.planRequested = this.cfg.planNextOnResume;
        s.gateReason = null;
        this.rescan(true);
        return false;
      }
      if (this.runOnce) {
        this.exitInfo = { ok: false, gated: true, message: `human gate: ${s.gateReason ?? ''}` };
        return true;
      }
      await this.waitForWake();
      return false;
    }

    this.resumeRequested = false;

    if (s.paused && s.state !== 'IDLE') {
      // Finish nothing while paused; hold before launching the next agent.
      if (this.runOnce) {
        this.exitInfo = { ok: true, gated: false, message: 'pipeline is paused; run "asterim-pipeline resume" first' };
        return true;
      }
      await this.waitForWake();
      return false;
    }

    switch (s.state) {
      case 'IDLE': {
        const taskF = this.readProto('task');
        if (taskF.hash != null && taskF.hash !== s.hashes.task) {
          const task = parseTaskFile(taskF.text);
          if (!task.valid) {
            this.log.warn(`ignoring ${this.cfg.files.task}: ${task.problems.join('; ')}`);
            s.hashes.task = taskF.hash;
            this.save();
          } else if (task.phaseComplete) {
            s.hashes.task = taskF.hash;
            this.phaseCompleteGate(task);
            return false;
          } else if (s.paused) {
            if (this.runOnce) {
              this.exitInfo = { ok: true, gated: false, message: 'pipeline is paused; run "asterim-pipeline resume" first' };
              return true;
            }
            await this.waitForWake();
            return false;
          } else {
            s.hashes.task = taskF.hash;
            s.taskId = task.taskId;
            s.phase = task.phase ?? s.phase;
            s.startedAt = new Date().toISOString();
            s.consecutiveBlocked = 0;
            this.resetTimings();
            this.log.info(`new task detected: ${task.taskId}${task.phase ? ` (phase ${task.phase})` : ''}`);
            this.setState('TASK_READY');
          }
          return false;
        }
        if (this.planRequested) {
          this.planRequested = false;
          if (s.paused) return this.runOnce ? true : (await this.waitForWake(), false);
          this.log.info('planning the next step from the roadmap');
          await this.orchestratorStep(
            `the phase-complete marker already in ${this.cfg.files.task} HAS ALREADY been reviewed and approved by ` +
              'the human, so do NOT re-declare it — replace that file with the FIRST task of the next unit of work',
            true,
          );
          return this.afterOrchestrationOnce();
        }
        if (this.runOnce) {
          this.exitInfo = { ok: true, gated: false, message: 'no new task; nothing to do' };
          return true;
        }
        await this.waitForWake();
        return false;
      }
      case 'TASK_READY': {
        const wait = await this.waitForWorkerIfOffline();
        if (wait !== null) return wait;
        await this.coderStep();
        return false;
      }
      case 'CODE_REPORT_READY': {
        const spec = parseTestSpec(this.readProto('testSpec').text);
        const specUsable = spec.exists && (spec.taskId == null || spec.taskId === s.taskId);
        if (specUsable) {
          const wait = await this.waitForWorkerIfOffline();
          if (wait !== null) return wait;
          await this.testerStep();
        } else if (this.cfg.skipTestingIfNoTestSpec) {
          this.log.warn(
            spec.exists
              ? `test spec ${this.cfg.files.testSpec} is for task ${spec.taskId}, not ${s.taskId}; skipping TESTING`
              : `no test spec at ${this.cfg.files.testSpec}; skipping TESTING`,
          );
          s.lastTestResult = 'SKIPPED';
          await this.orchestratorStep('no tests were specified for this task');
          return this.afterOrchestrationOnce();
        } else {
          this.gate(`Test spec ${this.cfg.files.testSpec} is missing or does not match task ${s.taskId}.`, [
            'skipTestingIfNoTestSpec is disabled, so the pipeline will not continue without it.',
          ]);
        }
        return false;
      }
      case 'TEST_REPORT_READY':
        await this.orchestratorStep(
          s.lastTestResult === 'FAIL' ? 'the required tests FAILED' : 'tests passed',
        );
        return this.afterOrchestrationOnce();
      case 'BLOCKED':
        await this.orchestratorStep(`the coder reported ${s.lastCoderStatus ?? 'BLOCKED'}`);
        return this.afterOrchestrationOnce();
      default:
        // CODING/TESTING/ORCHESTRATING are transient inside steps; hitting one
        // here means the in-memory state is inconsistent.
        this.gate(`Pipeline reached inconsistent state ${s.state}.`, []);
        return false;
    }
  }

  /**
   * In distributed mode, hold before launching coder/tester while no worker
   * is online. Returns null to proceed, or a boolean loop-result to bubble up.
   * @returns {Promise<boolean|null>}
   */
  async waitForWorkerIfOffline() {
    if (!this.remote || this.remote.online()) {
      this.waitingForWorkerLogged = false;
      return null;
    }
    if (this.runOnce) {
      this.exitInfo = { ok: false, gated: false, message: 'no worker online; cannot dispatch' };
      return true;
    }
    if (!this.waitingForWorkerLogged) {
      this.log.info('waiting for a worker to register before dispatching');
      this.waitingForWorkerLogged = true;
    }
    await this.waitForWake();
    return false;
  }

  afterOrchestrationOnce() {
    if (!this.runOnce) return false;
    const s = this.st;
    if (s.state === 'TASK_READY' || s.state === 'IDLE') {
      this.exitInfo = { ok: true, gated: false, message: `cycle complete; next state ${s.state}` };
      return true;
    }
    return false; // gate states are handled at the top of stepOnce
  }

  // ---------- agent steps ----------

  /**
   * @param {'coder'|'tester'|'orchestrator'} role
   * @param {string} prompt
   * @returns {Promise<import('./remote.js').RemoteAgentResult>}
   */
  async launch(role, prompt) {
    this.bus?.mark(role, `${role} started for ${this.st.taskId ?? '?'}`);
    const startedMs = Date.now();
    /** Fold this run's duration into the current task's totals. */
    const stopClock = () => {
      this.st.timings[`${role}Ms`] += Date.now() - startedMs;
      this.save();
    };
    if (this.remote && (role === 'coder' || role === 'tester')) {
      this.agentAbort = new AbortController();
      this.log.info(`dispatching ${role} to worker ${this.remote.workerId()} (task ${this.st.taskId ?? '?'})`);
      const res = await this.remote.runAgent(
        role, prompt, this.st.taskId ?? '', this.agentAbort.signal, this.cfg.agents[role].timeoutMinutes,
      );
      this.agentAbort = null;
      this.log.info(
        res.workerOffline ? `${role} dispatch failed: worker offline`
        : res.dispatchTimeout ? `${role} dispatch timed out waiting for a result`
        : res.gitConflict ? `${role} hit a git conflict on the worker (${res.gitConflict.stage})`
        : res.remoteError ? `${role} failed on the worker: ${res.remoteError}`
        : `${role} finished on worker: code=${res.code}${res.timedOut ? ' (timed out)' : ''} committed=${res.committed} pushed=${res.pushed}`,
      );
      stopClock();
      return res;
    }
    this.agentAbort = new AbortController();
    const agentCfg = this.cfg.agents[role];
    this.log.info(`launching ${role}: ${agentCfg.command} ${agentCfg.args.join(' ')}`);
    // Mirror the agent's output into this terminal, one prefixed line at a
    // time, so a locally-run agent (typically the orchestrator) is not
    // silent. It is captured to .pipeline/logs/ either way.
    let pending = '';
    const emit = (/** @type {string} */ line) => process.stdout.write(`  ${role} | ${line}\n`);
    const onOutput = (/** @type {Buffer} */ chunk) => {
      this.bus?.append(role, chunk.toString());
      if (!this.cfg.streamAgentOutput) return;
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) emit(line);
    };
    const res = await runAgent(role, agentCfg, prompt, this.root, {
      onSpawn: (pid) => {
        this.st[`${role}Pid`] = pid;
        this.save();
        this.log.info(`${role} running (pid ${pid})`);
      },
      signal: this.agentAbort.signal,
      onOutput,
    });
    if (pending.trim() !== '') emit(pending);
    this.bus?.flush(role);
    stopClock();
    this.agentAbort = null;
    this.st[`${role}Pid`] = null;
    this.log.info(
      res.spawnError
        ? `${role} failed to launch: ${res.spawnError}`
        : `${role} exited code=${res.code}${res.timedOut ? ' (timed out)' : ''} log=${path.relative(this.root, res.logFile)}`,
    );
    // Local mode: the log is right here, so a gate can quote it too.
    return { ...res, logFileLocal: res.logFile };
  }

  /**
   * Common post-exit checks. Returns true if the step must abort.
   * @param {'coder'|'tester'|'orchestrator'} role
   * @param {import('./remote.js').RemoteAgentResult} res
   */
  agentAborted(role, res) {
    if (this.stopRequested) {
      // Agent was killed (or died) while stopping: the task is not finished.
      this.st.interrupted = true;
      this.save();
      this.log.warn(`${role} interrupted by stop; task ${this.st.taskId ?? '?'} left unfinished`);
      return true;
    }
    if (res.workerOffline) {
      this.gate(`Worker went offline while the ${role} was running (task ${this.st.taskId ?? '?'}).`, [
        'RUNNING TASK -> WORKER OFFLINE -> HUMAN GATE',
        'The task will NOT be restarted automatically. When the worker reconnects,',
        'review the repository state and run "asterim-pipeline resume"; the pipeline',
        'will re-evaluate the protocol files to find the safe recovery point.',
      ]);
      return true;
    }
    if (res.dispatchTimeout) {
      this.gate(`No ${role} result arrived from the worker within the dispatch timeout.`, [
        `Task: ${this.st.taskId ?? '?'}. The worker may be stuck; check its logs.`,
      ]);
      return true;
    }
    if (res.gitConflict) {
      this.gate(`WORKER_GIT_CONFLICT: the worker could not ${res.gitConflict.stage === 'push' ? 'push' : 'fast-forward pull'} (task ${this.st.taskId ?? '?'}).`, [
        res.gitConflict.detail,
        'Resolve the git state on the worker manually (no destructive commands are ever run automatically).',
      ]);
      return true;
    }
    if (res.remoteError) {
      this.gate(`Worker reported an error while running the ${role}: ${res.remoteError}`, agentOutputDetail(res));
      return true;
    }
    if (res.spawnError) {
      this.gate(`The ${role} could not be launched: ${res.spawnError}`, [
        `Check the "${role}" command in .pipeline/config.json${this.remote ? ' on the worker machine' : ''}.`,
        ...agentOutputDetail(res),
      ]);
      return true;
    }
    if (res.timedOut) {
      this.gate(`The ${role} exceeded its ${this.cfg.agents[role].timeoutMinutes} minute timeout and was killed.`, [
        `Task: ${this.st.taskId ?? '?'}`,
        ...agentOutputDetail(res),
      ]);
      return true;
    }
    return false;
  }

  async coderStep() {
    const s = this.st;
    const task = parseTaskFile(this.readProto('task').text);
    if (!task.valid || task.taskId !== s.taskId) {
      this.gate(`Task file changed unexpectedly before the coder was launched (expected ${s.taskId}).`, []);
      return;
    }

    const useGit = this.cfg.git.enabled && gitx.isRepo(this.root);
    if (this.remote) {
      // The worker syncs via git: the task protocol files must be on the
      // remote before dispatch (commit is additive and scoped to those files).
      const pub = this.remote.publishTaskFiles(s.taskId ?? '');
      if (!pub.ok) {
        this.gate(`Could not publish the task files to the git remote: ${pub.error}`, [
          'Distributed mode requires a shared git remote with an upstream-tracking branch.',
        ]);
        return;
      }
    } else if (useGit && this.cfg.git.pullBeforeCycle) {
      const pull = gitx.pullFfOnly(this.root);
      if (!pull.ok) {
        this.gate('git pull --ff-only failed before the coder cycle.', [pull.stderr || pull.stdout]);
        return;
      }
    }
    s.preCoderHeadSha = useGit ? gitx.headSha(this.root) : null;
    // Remember the report as it stands BEFORE the run: if the agent cannot
    // write it (denied permission, crash, wrong path), a stale report from a
    // previous run must never be mistaken for this run's result.
    const reportBefore = this.readProto('coderReport').hash;

    this.setState('CODING');
    const res = await this.launch('coder', renderPrompt(this.cfg.prompts.coder, this.promptVars()));
    if (this.agentAborted('coder', res)) return;

    if (this.remote) {
      const sync = this.remote.syncAfterRemote('coder', res);
      if (!sync.ok) {
        this.gate(`Could not sync the coder's work from the git remote: ${sync.error}`, [
          'Resolve the git state manually, then run "asterim-pipeline resume".',
        ]);
        return;
      }
    }

    const repF = this.readProto('coderReport');
    const rep = parseCoderReport(repF.text);
    s.hashes.coderReport = repF.hash;
    if (repF.hash != null && repF.hash === reportBefore) {
      this.gate(`Coder exited (code ${res.code}) but ${this.cfg.files.coderReport} was not modified — it still holds the previous run's content.`, [
        'The agent most likely could not write the file (denied file-write permission in headless mode?).',
        `Check the coder log under ${PIPELINE_DIR}/logs/ ${this.remote ? 'on the worker machine ' : ''}for a denial message,`,
        'and make sure the agent is allowed to write the report file.',
      ]);
      return;
    }
    if (!rep.valid) {
      this.gate(`Coder exited (code ${res.code}) but ${this.cfg.files.coderReport} is missing or malformed.`, [
        ...rep.problems,
        ...agentOutputDetail(res),
      ]);
      return;
    }
    if (rep.taskId !== s.taskId) {
      this.gate(`Coder report is for task ${rep.taskId}, expected ${s.taskId}.`, agentOutputDetail(res));
      return;
    }
    s.lastCoderStatus = rep.status;

    if (rep.status === 'BLOCKED' || rep.status === 'FAILED') {
      s.consecutiveBlocked += 1;
      this.log.warn(`coder reported ${rep.status} for task ${s.taskId} (${s.consecutiveBlocked} in a row)`);
      if (s.consecutiveBlocked > this.cfg.maxConsecutiveBlocked) {
        this.gate(`Coder reported ${rep.status} ${s.consecutiveBlocked} times in a row for this task.`, [
          `Review ${this.cfg.files.coderReport}.`,
        ]);
      } else {
        this.setState('BLOCKED');
      }
      return;
    }

    if (useGit && this.cfg.git.validateCoderCommit && task.expectCodeChanges) {
      const head = gitx.headSha(this.root);
      const committed = head !== s.preCoderHeadSha;
      // Uncommitted pipeline bookkeeping (.pipeline/*) and the protocol files
      // themselves do not count as evidence of code changes.
      const ignorable = new Set(Object.values(this.cfg.files).map((p) => p.replace(/\\/g, '/')));
      const codeChanges = gitx
        .changedPaths(this.root)
        .filter((p) => !p.startsWith(`${PIPELINE_DIR}/`) && p !== PIPELINE_DIR && !ignorable.has(p));
      if (!committed && codeChanges.length === 0) {
        this.gate(`Coder reported COMPLETE for ${s.taskId} but git shows no new commit and no code changes.`, [
          'If this task genuinely changes no code, add "No-Code-Changes: true" to the task file.',
        ]);
        return;
      }
      if (!committed && codeChanges.length > 0) this.log.warn('coder left uncommitted changes and made no commit');
      if (committed && this.cfg.git.pushAfterCommit) {
        const p = gitx.push(this.root);
        if (!p.ok) this.log.warn(`git push failed (continuing): ${p.stderr || p.stdout}`);
      }
    }

    if (res.code !== 0) this.log.warn(`coder exit code ${res.code} but report is valid; continuing`);
    s.tasksExecuted += 1;
    this.setState('CODE_REPORT_READY');
  }

  async testerStep() {
    const s = this.st;
    const reportBefore = this.readProto('testReport').hash;
    this.setState('TESTING');
    const res = await this.launch('tester', renderPrompt(this.cfg.prompts.tester, this.promptVars()));
    if (this.agentAborted('tester', res)) return;

    if (this.remote) {
      const sync = this.remote.syncAfterRemote('tester', res);
      if (!sync.ok) {
        this.gate(`Could not sync the tester's report: ${sync.error}`, []);
        return;
      }
    }

    const repF = this.readProto('testReport');
    const rep = parseTestReport(repF.text);
    s.hashes.testReport = repF.hash;
    if (repF.hash != null && repF.hash === reportBefore) {
      this.gate(`Tester exited (code ${res.code}) but ${this.cfg.files.testReport} was not modified — it still holds the previous run's content.`, [
        'The agent most likely could not write the file (denied file-write permission in headless mode?).',
        `Check the tester log under ${PIPELINE_DIR}/logs/ ${this.remote ? 'on the worker machine ' : ''}for a denial message.`,
      ]);
      return;
    }
    if (!rep.valid) {
      this.gate(`Tester exited (code ${res.code}) but ${this.cfg.files.testReport} is missing or malformed.`, [
        ...rep.problems,
        ...agentOutputDetail(res),
      ]);
      return;
    }
    if (rep.taskId !== s.taskId) {
      this.gate(`Test report is for task ${rep.taskId}, expected ${s.taskId}.`, agentOutputDetail(res));
      return;
    }
    s.lastTestResult = rep.result;
    if (rep.result === 'PASS') {
      s.consecutiveTestFailures = 0;
      if (res.code !== 0) this.log.warn('test report says PASS but tester exit code was nonzero');
    } else {
      s.consecutiveTestFailures += 1;
      this.log.warn(`tests FAILED for task ${s.taskId} (${s.consecutiveTestFailures} consecutive failure(s))`);
      if (s.consecutiveTestFailures >= this.cfg.maxConsecutiveTestFailures) {
        this.gate(`Tests have failed ${s.consecutiveTestFailures} times in a row.`, [
          `Review ${this.cfg.files.testReport} and ${this.cfg.files.coderReport}.`,
        ]);
        return;
      }
    }
    this.setState('TEST_REPORT_READY');
  }

  /**
   * @param {string} trigger short human-readable reason shown to the orchestrator
   * @param {boolean} [planning] true when invoked to plan the next unit after
   *   a resumed gate, where re-declaring phase completion is not progress
   */
  async orchestratorStep(trigger, planning = false) {
    const s = this.st;
    const before = this.readProto('task');
    this.setState('ORCHESTRATING');
    const prompt = renderPrompt(this.orchestratorPrompt(), this.promptVars({ trigger: ` — note: ${trigger}` }));
    const res = await this.launch('orchestrator', prompt);
    if (this.agentAborted('orchestrator', res)) return;

    const after = this.readProto('task');
    if (after.hash == null || after.hash === before.hash) {
      this.gate(`Orchestrator exited (code ${res.code}) without updating ${this.cfg.files.task}.`, [
        'The pipeline cannot determine the next task.',
        ...agentOutputDetail(res),
      ]);
      return;
    }
    const task = parseTaskFile(after.text);
    s.hashes.task = after.hash;
    if (!task.valid) {
      this.gate(`Orchestrator wrote a malformed ${this.cfg.files.task}.`, [...task.problems, ...agentOutputDetail(res)]);
      return;
    }
    if (task.phaseComplete) {
      if (planning) {
        // It was asked for the next unit and repeated the marker the human
        // just cleared. Gating beats bouncing between gate and resume.
        this.gate('Orchestrator re-declared the phase complete instead of planning the next unit of work.', [
          'That gate was already reviewed and resumed, so this is not progress.',
          `Write the first task of the next unit to ${this.cfg.files.task} yourself, or adjust the roadmap ` +
            'so the next unit is unambiguous, then resume.',
          ...agentOutputDetail(res),
        ]);
        return;
      }
      this.phaseCompleteGate(task);
      return;
    }
    // The previous attempt is finished the moment a next task is issued.
    this.recordHistory('advanced');
    if (task.taskId !== s.taskId) s.consecutiveBlocked = 0;
    s.taskId = task.taskId;
    s.phase = task.phase ?? s.phase;
    s.startedAt = new Date().toISOString();
    this.resetTimings();
    this.log.info(`orchestrator issued next task: ${task.taskId}`);
    this.setState('TASK_READY');
  }

  // ---------- gates ----------

  /**
   * @param {string} reason
   * @param {string[]} details
   */
  gate(reason, details = []) {
    const s = this.st;
    this.recordHistory('gated');
    s.gateReason = reason;
    s.coderPid = s.testerPid = s.orchestratorPid = null;
    const from = s.state;
    s.state = 'HUMAN_GATE';
    this.save();
    this.log.error(`HUMAN_GATE (from ${from}): ${reason}`);
    this.log.banner([
      'HUMAN REVIEW REQUIRED',
      reason,
      ...details,
      'Review:',
      `  ${this.cfg.files.coderReport}`,
      `  ${this.cfg.files.testReport}`,
      `  ${PIPELINE_DIR}/pipeline.log`,
      'Pipeline is paused.',
      'Run "asterim-pipeline resume" to continue after review.',
    ]);
    this.emit('gate', { reason, from });
  }

  /** @param {ReturnType<typeof parseTaskFile>} task */
  phaseCompleteGate(task) {
    const s = this.st;
    const phase = task.phase ?? s.phase ?? '?';
    if (!this.cfg.humanGateOnPhaseComplete) {
      this.log.info(`phase ${phase} complete (humanGateOnPhaseComplete disabled); going IDLE`);
      if (s.state !== 'IDLE') this.setState('IDLE');
      return;
    }
    this.recordHistory('phase-complete');
    s.gateReason = `Phase ${phase} has completed.`;
    s.coderPid = s.testerPid = s.orchestratorPid = null;
    const from = s.state;
    s.state = 'HUMAN_GATE';
    this.save();
    this.log.error(`HUMAN_GATE (from ${from}): phase ${phase} complete`);
    this.log.banner([
      'HUMAN REVIEW REQUIRED',
      `Phase ${phase} has completed.`,
      `Tasks executed: ${s.tasksExecuted}`,
      `Last coder status: ${s.lastCoderStatus ?? 'n/a'}`,
      `Last test result: ${s.lastTestResult ?? 'n/a'}`,
      'Review:',
      `  ${this.cfg.files.coderReport}`,
      `  ${this.cfg.files.testReport}`,
      'Pipeline is paused.',
      `Have the orchestrator (or yourself) write the next ${this.cfg.files.task},`,
      'then run "asterim-pipeline resume".',
    ]);
    this.emit('gate', { reason: s.gateReason, from });
  }
}
