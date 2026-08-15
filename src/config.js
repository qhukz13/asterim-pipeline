// Configuration: .pipeline/config.json + environment overrides + defaults.

import fs from 'node:fs';
import path from 'node:path';

export const PIPELINE_DIR = '.pipeline';

export const DEFAULT_PROMPTS = {
  coder:
    'Read AGENTS.md, CLAUDE.md, and tasks/current.md.\n' +
    'Execute the current task ({taskId}).\n' +
    'Before reporting completion, independently review the git diff against every acceptance criterion and fix any issues.\n' +
    'Run all required verification.\n' +
    'Write the final report to reports/current.md, including the lines "Task-ID: {taskId}" and "Status: COMPLETE" (or BLOCKED/FAILED).\n' +
    'Commit the completed work.',
  tester:
    'Read AGENTS.md, CLAUDE.md, tasks/current.md, reports/current.md, and test/current.md.\n' +
    'Execute ONLY the tests specified in test/current.md.\n' +
    'Do not modify production code.\n' +
    'Write the complete verification result to test/report.md, including the lines "Task-ID: {taskId}" and "Result: PASS" (or FAIL).\n' +
    'Return the process exit status based on whether the required verification passed.',
  orchestrator:
    'Read AGENTS.md, CLAUDE.md, reports/current.md, and test/report.md.\n' +
    'Review the implementation and test results for task {taskId}{trigger}.\n' +
    'Decide the next task. Do not modify implementation code yourself.\n' +
    'Write the next task to tasks/current.md, including a "Task-ID: <id>" line, an optional "Phase: <n>" line, ' +
    'and if tests must be run for it, write test/current.md.\n' +
    'If the current phase is complete, instead write "Status: PHASE_COMPLETE" to tasks/current.md.',
};

/** Protocol file locations, relative to project root. */
export const DEFAULT_FILES = {
  task: 'tasks/current.md',
  coderReport: 'reports/current.md',
  testSpec: 'test/current.md',
  testReport: 'test/report.md',
};

/**
 * @typedef {{command: string, args: string[], promptVia: 'stdin'|'arg', timeoutMinutes: number}} AgentConfig
 * @typedef {{
 *   projectRoot: string,
 *   watchDebounceMs: number,
 *   humanGateOnPhaseComplete: boolean,
 *   maxConsecutiveTestFailures: number,
 *   maxConsecutiveBlocked: number,
 *   skipTestingIfNoTestSpec: boolean,
 *   agents: {coder: AgentConfig, tester: AgentConfig, orchestrator: AgentConfig},
 *   git: {enabled: boolean, validateCoderCommit: boolean, pullBeforeCycle: boolean, pushAfterCommit: boolean},
 *   remote: {bind: string, port: number, heartbeatIntervalMs: number, heartbeatTimeoutMs: number,
 *            pollTimeoutMs: number, redeliverMs: number, dispatchGraceMinutes: number,
 *            allowPublicClients: boolean, autoCommitTaskFiles: boolean},
 *   prompts: {coder: string, tester: string, orchestrator: string},
 *   files: {task: string, coderReport: string, testSpec: string, testReport: string},
 * }} Config
 */

/** @param {string} command @param {Partial<AgentConfig>} [over] @returns {AgentConfig} */
function agentDefaults(command, over = {}) {
  return {
    command,
    // "-p" puts claude CLI into non-interactive print mode; the prompt itself
    // is piped via stdin to avoid shell-quoting problems on Windows.
    args: ['-p'],
    promptVia: 'stdin',
    timeoutMinutes: 60,
    ...over,
  };
}

/** @param {string} projectRoot @returns {Config} */
export function defaultConfig(projectRoot) {
  return {
    projectRoot,
    watchDebounceMs: 1000,
    humanGateOnPhaseComplete: true,
    maxConsecutiveTestFailures: 3,
    maxConsecutiveBlocked: 2,
    skipTestingIfNoTestSpec: true,
    agents: {
      coder: agentDefaults('claude'),
      tester: agentDefaults('claude'),
      orchestrator: agentDefaults('agy', { args: [], timeoutMinutes: 30 }),
    },
    git: { enabled: true, validateCoderCommit: true, pullBeforeCycle: false, pushAfterCommit: false },
    remote: {
      bind: '0.0.0.0', // LAN-reachable; protect with firewall rules + token (see README)
      port: 4317,
      heartbeatIntervalMs: 10000,
      heartbeatTimeoutMs: 30000,
      pollTimeoutMs: 25000,
      redeliverMs: 5000, // how often an unacknowledged command is re-offered to the worker
      dispatchGraceMinutes: 5, // added to the agent timeout for the orchestrator-side dispatch timeout
      allowPublicClients: false,
      autoCommitTaskFiles: true, // commit+push tasks/current.md & test/current.md before dispatching
    },
    prompts: { ...DEFAULT_PROMPTS },
    files: { ...DEFAULT_FILES },
  };
}

/**
 * Merge a raw config object (from .pipeline/config.json) over the defaults.
 * Supports both the nested form ({agents:{coder:{command}}}) and the flat
 * shorthand from the spec (coderCommand / testerCommand / orchestratorCommand,
 * plus optional coderArgs / testerArgs / orchestratorArgs).
 * @param {string} projectRoot
 * @param {Record<string, any>} raw
 * @returns {Config}
 */
export function mergeConfig(projectRoot, raw) {
  const cfg = defaultConfig(projectRoot);
  if (typeof raw.projectRoot === 'string' && raw.projectRoot.trim() !== '') {
    cfg.projectRoot = path.resolve(projectRoot, raw.projectRoot);
  }
  for (const key of /** @type {const} */ (['watchDebounceMs', 'maxConsecutiveTestFailures', 'maxConsecutiveBlocked'])) {
    if (typeof raw[key] === 'number' && raw[key] >= 0) cfg[key] = raw[key];
  }
  for (const key of /** @type {const} */ (['humanGateOnPhaseComplete', 'skipTestingIfNoTestSpec'])) {
    if (typeof raw[key] === 'boolean') cfg[key] = raw[key];
  }
  for (const role of /** @type {const} */ (['coder', 'tester', 'orchestrator'])) {
    const flat = raw[`${role}Command`];
    if (typeof flat === 'string' && flat.trim() !== '') cfg.agents[role].command = flat;
    const flatArgs = raw[`${role}Args`];
    if (Array.isArray(flatArgs) && flatArgs.every((a) => typeof a === 'string')) cfg.agents[role].args = flatArgs;
    const nested = raw.agents?.[role];
    if (nested && typeof nested === 'object') {
      if (typeof nested.command === 'string' && nested.command.trim() !== '') cfg.agents[role].command = nested.command;
      if (Array.isArray(nested.args) && nested.args.every((/** @type {any} */ a) => typeof a === 'string')) cfg.agents[role].args = nested.args;
      if (nested.promptVia === 'stdin' || nested.promptVia === 'arg') cfg.agents[role].promptVia = nested.promptVia;
      if (typeof nested.timeoutMinutes === 'number' && nested.timeoutMinutes >= 0) cfg.agents[role].timeoutMinutes = nested.timeoutMinutes;
    }
    if (typeof raw.prompts?.[role] === 'string') cfg.prompts[role] = raw.prompts[role];
  }
  if (raw.git && typeof raw.git === 'object') {
    for (const key of /** @type {const} */ (['enabled', 'validateCoderCommit', 'pullBeforeCycle', 'pushAfterCommit'])) {
      if (typeof raw.git[key] === 'boolean') cfg.git[key] = raw.git[key];
    }
  }
  if (raw.remote && typeof raw.remote === 'object') {
    if (typeof raw.remote.bind === 'string' && raw.remote.bind.trim() !== '') cfg.remote.bind = raw.remote.bind;
    for (const key of /** @type {const} */ ([
      'port', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'pollTimeoutMs', 'redeliverMs', 'dispatchGraceMinutes',
    ])) {
      if (typeof raw.remote[key] === 'number' && raw.remote[key] >= 0) cfg.remote[key] = raw.remote[key];
    }
    for (const key of /** @type {const} */ (['allowPublicClients', 'autoCommitTaskFiles'])) {
      if (typeof raw.remote[key] === 'boolean') cfg.remote[key] = raw.remote[key];
    }
  }
  if (raw.files && typeof raw.files === 'object') {
    for (const key of /** @type {const} */ (['task', 'coderReport', 'testSpec', 'testReport'])) {
      if (typeof raw.files[key] === 'string' && raw.files[key].trim() !== '') cfg.files[key] = raw.files[key];
    }
  }
  return cfg;
}

/**
 * Environment overrides (applied last):
 *   ASTERIM_PIPELINE_CODER_COMMAND / _TESTER_COMMAND / _ORCHESTRATOR_COMMAND
 *   ASTERIM_PIPELINE_DEBOUNCE_MS
 * @param {Config} cfg
 * @param {NodeJS.ProcessEnv} env
 */
export function applyEnvOverrides(cfg, env = process.env) {
  for (const role of /** @type {const} */ (['coder', 'tester', 'orchestrator'])) {
    const v = env[`ASTERIM_PIPELINE_${role.toUpperCase()}_COMMAND`];
    if (v && v.trim() !== '') cfg.agents[role].command = v;
  }
  const d = env.ASTERIM_PIPELINE_DEBOUNCE_MS;
  if (d && /^\d+$/.test(d)) cfg.watchDebounceMs = Number(d);
  return cfg;
}

/**
 * Load config for a project root. Missing config file is fine (all defaults).
 * A malformed config file is an error: the agent commands must be explicit,
 * so we refuse to guess.
 * @param {string} projectRoot
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Config}
 */
export function loadConfig(projectRoot, env = process.env) {
  const file = path.join(projectRoot, PIPELINE_DIR, 'config.json');
  /** @type {Record<string, any>} */
  let raw = {};
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`invalid JSON in ${file}: ${/** @type {Error} */ (err).message}`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`invalid config in ${file}: expected a JSON object`);
    }
  }
  return applyEnvOverrides(mergeConfig(projectRoot, raw), env);
}
