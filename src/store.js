// Persistent pipeline state: .pipeline/state.json (atomic writes).

import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_DIR } from './config.js';

/**
 * @typedef {import('./state-machine.js').PipelineState} PipelineState
 * @typedef {{
 *   state: PipelineState,
 *   phase: string|null,
 *   taskId: string|null,
 *   startedAt: string|null,
 *   updatedAt: string|null,
 *   coderPid: number|null,
 *   testerPid: number|null,
 *   orchestratorPid: number|null,
 *   paused: boolean,
 *   interrupted: boolean,
 *   gateReason: string|null,
 *   hashes: {task: string|null, coderReport: string|null, testSpec: string|null, testReport: string|null},
 *   consecutiveTestFailures: number,
 *   consecutiveBlocked: number,
 *   tasksExecuted: number,
 *   lastCoderStatus: string|null,
 *   lastTestResult: string|null,
 *   preCoderHeadSha: string|null,
 *   timings: {coderMs: number, testerMs: number, orchestratorMs: number},
 *   history: HistoryEntry[],
 * }} PersistedState
 *
 * @typedef {{
 *   taskId: string|null, phase: string|null, startedAt: string|null, endedAt: string|null,
 *   coderStatus: string|null, testResult: string|null,
 *   coderMs: number, testerMs: number, orchestratorMs: number,
 *   outcome: string,
 * }} HistoryEntry
 */

/** Most recent task attempts kept in state.json. */
export const HISTORY_LIMIT = 20;

/** @returns {PersistedState} */
export function defaultState() {
  return {
    state: 'IDLE',
    phase: null,
    taskId: null,
    startedAt: null,
    updatedAt: null,
    coderPid: null,
    testerPid: null,
    orchestratorPid: null,
    paused: false,
    interrupted: false,
    gateReason: null,
    hashes: { task: null, coderReport: null, testSpec: null, testReport: null },
    consecutiveTestFailures: 0,
    consecutiveBlocked: 0,
    tasksExecuted: 0,
    lastCoderStatus: null,
    lastTestResult: null,
    preCoderHeadSha: null,
    timings: { coderMs: 0, testerMs: 0, orchestratorMs: 0 },
    history: [],
  };
}

/** @param {string} projectRoot */
export function statePath(projectRoot) {
  return path.join(projectRoot, PIPELINE_DIR, 'state.json');
}

/**
 * Read persisted state. Returns {state, corrupt}: a corrupt or unreadable
 * state file yields defaults with corrupt=true so the caller can enter
 * HUMAN_GATE instead of guessing.
 * @param {string} projectRoot
 * @returns {{state: PersistedState, existed: boolean, corrupt: boolean}}
 */
export function readState(projectRoot) {
  const file = statePath(projectRoot);
  if (!fs.existsSync(file)) return { state: defaultState(), existed: false, corrupt: false };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || typeof raw.state !== 'string') {
      return { state: defaultState(), existed: true, corrupt: true };
    }
    const base = defaultState();
    return {
      state: {
        ...base,
        ...raw,
        hashes: { ...base.hashes, ...(raw.hashes ?? {}) },
        timings: { ...base.timings, ...(raw.timings ?? {}) },
        history: Array.isArray(raw.history) ? raw.history : [],
      },
      existed: true,
      corrupt: false,
    };
  } catch {
    return { state: defaultState(), existed: true, corrupt: true };
  }
}

/**
 * Atomic write: temp file + rename, so a crash mid-write never leaves a
 * half-written state.json.
 * @param {string} projectRoot
 * @param {PersistedState} state
 */
export function writeState(projectRoot, state) {
  const file = statePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
