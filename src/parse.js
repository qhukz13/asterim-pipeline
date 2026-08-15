// Parsing of the repository protocol files.
//
// The repository files ARE the communication protocol, so the pipeline needs a
// small, forgiving-but-explicit convention to extract machine-readable facts:
//
//   tasks/current.md     Task-ID: P6-03        (or a "# Task P6-03" heading)
//                        Phase: 6              (optional)
//                        Status: PHASE_COMPLETE (orchestrator declares phase done)
//                        No-Code-Changes: true  (optional; task is docs/config only)
//
//   reports/current.md   Task-ID: P6-03
//                        Status: COMPLETE | BLOCKED | FAILED
//
//   test/current.md      Task-ID: P6-03        (optional but recommended)
//
//   test/report.md       Task-ID: P6-03
//                        Result: PASS | FAIL   ("Status:" also accepted)
//
// Field labels are case-insensitive and may use ":" or "=". Anything else in
// the files is free-form prose for the agents/humans.

import { createHash } from 'node:crypto';

/** @param {string} text */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {string} text
 * @param {string} label e.g. "task[-_ ]?id"
 * @returns {string|null}
 */
function field(text, label) {
  const re = new RegExp(`^[ \\t>*-]*${label}[ \\t]*[:=][ \\t]*(.+?)[ \\t]*$`, 'im');
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/;

/** @param {string} text @returns {string|null} */
export function extractTaskId(text) {
  const explicit = field(text, '(?:task[-_ ]?id)');
  if (explicit) {
    const id = explicit.replace(/^[`"']|[`"']$/g, '');
    return TASK_ID_RE.test(id) ? id : null;
  }
  // Fallback: "# Task P6-03" style heading.
  const h = /^#{1,6}[ \t]*task[ \t]+([A-Za-z0-9][A-Za-z0-9._\-\/]*)/im.exec(text);
  return h ? h[1] : null;
}

const PHASE_COMPLETE_RE = /^phase[ _\-]?complete$/i;

/**
 * @param {string|null} text
 * @returns {{valid: boolean, taskId: string|null, phase: string|null,
 *            phaseComplete: boolean, expectCodeChanges: boolean, problems: string[]}}
 */
export function parseTaskFile(text) {
  const problems = [];
  if (text == null || text.trim() === '') {
    return { valid: false, taskId: null, phase: null, phaseComplete: false, expectCodeChanges: true, problems: ['task file missing or empty'] };
  }
  const status = field(text, 'status');
  const phaseComplete = status != null && PHASE_COMPLETE_RE.test(status);
  const taskId = extractTaskId(text);
  const phase = field(text, 'phase');
  const noChanges = field(text, '(?:no[-_ ]?code[-_ ]?changes)');
  const expectCodeChanges = !(noChanges != null && /^(true|yes|1)$/i.test(noChanges));
  if (!phaseComplete && taskId == null) problems.push('no Task-ID found in task file');
  return { valid: phaseComplete || taskId != null, taskId, phase, phaseComplete, expectCodeChanges, problems };
}

/** Recognized coder report statuses, normalized. @type {Record<string, string>} */
const CODER_STATUS = {
  complete: 'COMPLETE',
  completed: 'COMPLETE',
  done: 'COMPLETE',
  success: 'COMPLETE',
  blocked: 'BLOCKED',
  failed: 'FAILED',
  fail: 'FAILED',
};

/**
 * @param {string|null} text
 * @returns {{valid: boolean, taskId: string|null, status: string|null, problems: string[]}}
 */
export function parseCoderReport(text) {
  const problems = [];
  if (text == null || text.trim() === '') {
    return { valid: false, taskId: null, status: null, problems: ['coder report missing or empty'] };
  }
  const taskId = extractTaskId(text);
  if (taskId == null) problems.push('no Task-ID found in coder report');
  const raw = field(text, 'status');
  const status = raw != null ? (CODER_STATUS[raw.toLowerCase()] ?? null) : null;
  if (status == null) problems.push(raw == null ? 'no Status field found in coder report' : `unrecognized coder status "${raw}"`);
  return { valid: taskId != null && status != null, taskId, status, problems };
}

/**
 * @param {string|null} text
 * @returns {{valid: boolean, taskId: string|null, result: 'PASS'|'FAIL'|null, problems: string[]}}
 */
export function parseTestReport(text) {
  const problems = [];
  if (text == null || text.trim() === '') {
    return { valid: false, taskId: null, result: null, problems: ['test report missing or empty'] };
  }
  const taskId = extractTaskId(text);
  if (taskId == null) problems.push('no Task-ID found in test report');
  const raw = field(text, '(?:result|status)');
  /** @type {'PASS'|'FAIL'|null} */
  let result = null;
  if (raw != null) {
    if (/^pass(ed)?$/i.test(raw)) result = 'PASS';
    else if (/^fail(ed)?$/i.test(raw)) result = 'FAIL';
  }
  if (result == null) problems.push(raw == null ? 'no Result/Status field found in test report' : `unrecognized test result "${raw}"`);
  return { valid: taskId != null && result != null, taskId, result, problems };
}

/**
 * Test spec (test/current.md). Only needs to exist; Task-ID is optional but
 * when present must match the current task.
 * @param {string|null} text
 * @returns {{exists: boolean, taskId: string|null}}
 */
export function parseTestSpec(text) {
  if (text == null || text.trim() === '') return { exists: false, taskId: null };
  return { exists: true, taskId: extractTaskId(text) };
}
