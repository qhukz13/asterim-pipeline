// "asterim-pipeline status" — read-only view of state.json + runner lock.

import { readState } from './store.js';
import { readLiveLock } from './control.js';
import { PIPELINE_DIR } from './config.js';

/** @param {string|null} iso */
function ago(iso) {
  if (!iso) return 'n/a';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'n/a';
  const min = Math.floor(ms / 60000);
  if (min < 1) return `${Math.floor(ms / 1000)}s ago`;
  if (min < 60) return `${min}m ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
}

/**
 * @param {string} root
 * @returns {{text: string, json: object}}
 */
export function getStatus(root) {
  const { state: s, existed } = readState(root);
  const lock = readLiveLock(root);
  const running = lock != null;

  /** @param {number|null} pid @param {string} idleLabel */
  const agentLine = (pid, idleLabel) => (pid != null ? `running (pid ${pid})` : idleLabel);

  const lines = [
    `Runner:         ${running ? `running (pid ${lock.pid}, since ${lock.startedAt})` : 'not running'}`,
    `State:          ${existed ? s.state : 'IDLE (no state yet)'}${s.paused ? ' [PAUSED]' : ''}`,
    `Phase:          ${s.phase ?? 'n/a'}`,
    `Task:           ${s.taskId ?? 'n/a'} (started ${ago(s.startedAt)})`,
    `Coder:          ${agentLine(s.coderPid, `idle, last status: ${s.lastCoderStatus ?? 'n/a'}`)}`,
    `Tester:         ${agentLine(s.testerPid, `idle, last result: ${s.lastTestResult ?? 'n/a'}`)}`,
    `Orchestrator:   ${agentLine(s.orchestratorPid, 'idle')}`,
    `Tasks executed: ${s.tasksExecuted}`,
  ];
  if (s.gateReason) lines.push(`Gate reason:    ${s.gateReason}`);
  lines.push(`Log:            ${PIPELINE_DIR}/pipeline.log`);
  return { text: lines.join('\n'), json: { running, runnerPid: lock?.pid ?? null, ...s } };
}
