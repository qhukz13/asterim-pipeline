// Explicit pipeline state machine. Pure data + validation, no I/O.

export const STATES = /** @type {const} */ ([
  'IDLE',
  'TASK_READY',
  'CODING',
  'CODE_REPORT_READY',
  'TESTING',
  'TEST_REPORT_READY',
  'ORCHESTRATING',
  'HUMAN_GATE',
  'BLOCKED',
  'FAILED',
]);

/** @typedef {typeof STATES[number]} PipelineState */

/**
 * Allowed transitions. HUMAN_GATE and FAILED are only left via an explicit
 * human "resume", which re-scans the protocol files and may land anywhere,
 * hence the wide fan-out from those two states.
 * @type {Record<PipelineState, PipelineState[]>}
 */
export const TRANSITIONS = {
  IDLE: ['TASK_READY', 'HUMAN_GATE', 'FAILED'],
  TASK_READY: ['CODING', 'HUMAN_GATE', 'FAILED'],
  CODING: ['CODE_REPORT_READY', 'BLOCKED', 'HUMAN_GATE', 'FAILED'],
  CODE_REPORT_READY: ['TESTING', 'ORCHESTRATING', 'HUMAN_GATE', 'FAILED'],
  TESTING: ['TEST_REPORT_READY', 'HUMAN_GATE', 'FAILED'],
  TEST_REPORT_READY: ['ORCHESTRATING', 'HUMAN_GATE', 'FAILED'],
  ORCHESTRATING: ['TASK_READY', 'IDLE', 'HUMAN_GATE', 'FAILED'],
  BLOCKED: ['ORCHESTRATING', 'HUMAN_GATE', 'FAILED'],
  HUMAN_GATE: ['IDLE', 'TASK_READY', 'CODE_REPORT_READY', 'TEST_REPORT_READY', 'BLOCKED', 'HUMAN_GATE', 'FAILED'],
  FAILED: ['IDLE', 'TASK_READY', 'CODE_REPORT_READY', 'TEST_REPORT_READY', 'BLOCKED', 'HUMAN_GATE'],
};

/** @param {string} s @returns {s is PipelineState} */
export function isState(s) {
  return /** @type {readonly string[]} */ (STATES).includes(s);
}

/**
 * @param {PipelineState} from
 * @param {PipelineState} to
 */
export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * @param {PipelineState} from
 * @param {PipelineState} to
 */
export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`illegal state transition ${from} -> ${to}`);
  }
}

/** States in which an agent process is (or was) running. */
export const AGENT_STATES = /** @type {const} */ ({
  CODING: 'coder',
  TESTING: 'tester',
  ORCHESTRATING: 'orchestrator',
});
