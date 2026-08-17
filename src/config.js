// Configuration: .pipeline/config.json + environment overrides + defaults.

import fs from 'node:fs';
import path from 'node:path';

export const PIPELINE_DIR = '.pipeline';

// Protocol file paths are injected as {taskFile} / {coderReportFile} /
// {testSpecFile} / {testReportFile} from `files` below — never hardcoded, or
// an agent would read and write a different path than the pipeline watches.
export const DEFAULT_PROMPTS = {
  coder:
    'Read AGENTS.md, CLAUDE.md, and {taskFile}.\n' +
    'Execute the current task ({taskId}).\n' +
    'You are running non-interactively and get exactly ONE session: there is no later turn, and nothing you leave ' +
    'running in the background will be observed. Do not end your turn with a progress update — the only thing the ' +
    'pipeline sees is the report file, so finish the work and write the report in this session.\n' +
    'If you run out of room, cannot finish, or a verification step is still inconclusive, that is fine: write the ' +
    'report anyway with "Status: BLOCKED" and describe exactly what remains. Never stop without writing it.\n' +
    'Before reporting completion, independently review the git diff against every acceptance criterion and fix any issues.\n' +
    'Run all required verification.\n' +
    'Write the final report to {coderReportFile} (that exact path). The report MUST begin with these two exact plain-text lines ' +
    '(no markdown bold, no emoji, no extra words on the line):\n' +
    'Task-ID: {taskId}\n' +
    'Status: COMPLETE\n' +
    '(use Status: BLOCKED or Status: FAILED instead if you could not finish). The rest of the report is free-form.\n' +
    'Commit the completed work.',
  tester:
    'Read AGENTS.md, CLAUDE.md, {taskFile}, {coderReportFile}, and {testSpecFile}.\n' +
    'Execute ONLY the tests specified in {testSpecFile}.\n' +
    'Do not modify production code.\n' +
    'You are running non-interactively and get exactly ONE session: finish and write the report in this session. ' +
    'If verification could not be completed, still write the report with "Result: FAIL" and explain what was not run.\n' +
    'Write the complete verification result to {testReportFile} (that exact path). The report MUST begin with these two exact plain-text lines ' +
    '(no markdown bold, no emoji, no extra words on the line):\n' +
    'Task-ID: {taskId}\n' +
    'Result: PASS\n' +
    '(use Result: FAIL instead if verification failed). The rest of the report is free-form.\n' +
    'Return the process exit status based on whether the required verification passed.',
  orchestrator:
    'You are the ORCHESTRATOR. Your entire job is: read the reports, judge the result, and write the next task. ' +
    'Other agents do the implementation and the testing — you never do either yourself.\n' +
    'Read AGENTS.md, CLAUDE.md, {coderReportFile}, and {testReportFile}.\n' +
    'Review the implementation and test results for task {taskId}{trigger}.\n' +
    '\n' +
    'HARD LIMITS — tool permissions are pre-approved for this run, so nothing but you enforces these:\n' +
    '  - Do NOT write, edit, refactor, or delete any source, config, or test code.\n' +
    '  - Do NOT run tests, builds, linters, typecheckers, package installers, or any other long-running command. ' +
    'The tester already ran the required verification; re-running it here wastes the session and can leave the ' +
    'working tree dirty for the next agent.\n' +
    '  - Do NOT commit, push, stage, stash, or otherwise change git state. The pipeline owns git.\n' +
    '  - The ONLY files you may create or modify are {taskFile} and {testSpecFile}.\n' +
    '  - Read-only inspection is encouraged: read any file, and use read-only git (log, diff, show, status) ' +
    'to check what the coder actually changed.\n' +
    '\n' +
    'You are running non-interactively and get exactly ONE session: do not end your turn with a progress update, ' +
    'and do not leave work running in the background. Write the task file in this session or the pipeline stalls.\n' +
    'Decide ONE next task (not a list). If the reports show the work is incomplete, unverified, or the tests ' +
    'failed, the next task is a focused fix task quoting the specific failure. If the coder reported an unrelated ' +
    'problem it discovered, record it as a separate future task rather than expanding the current one.\n' +
    'Write the next task to {taskFile} (that exact path). It MUST contain an exact plain-text line "Task-ID: <id>" ' +
    '(no markdown bold) and optionally "Phase: <n>"; if tests must be run for it, write {testSpecFile} ' +
    '(that exact path) with a matching "Task-ID: <id>" line.\n' +
    'Do not create or write any other task/report path variant.\n' +
    'If the current phase is complete, instead write "Status: PHASE_COMPLETE" to {taskFile}.',

  // Appended to the orchestrator prompt only when files.roadmap is configured.
  orchestratorRoadmap:
    '\nROADMAP-DRIVEN PLANNING\n' +
    'Read {roadmapFile} before deciding anything. It is the authoritative plan; {taskFile} is only ever ' +
    'ONE small step out of it.\n' +
    'Work the roadmap in the order it presents its sections, always continuing the earliest section that is not ' +
    'yet finished, and finishing it before starting the next. Do not skip ahead, and do not interleave sections.\n' +
    'Break the current section into PR-sized tasks: one coherent change a reviewer could read in a sitting, ' +
    'independently verifiable, and leaving the tree in a working state. A section is normally several such tasks. ' +
    'Dispatch exactly ONE of them — the next one — per turn.\n' +
    'Decide per task whether it needs verification: write {testSpecFile} when the tester must run something, and ' +
    'omit it when the change genuinely cannot be tested (docs, config), saying so in the task itself.\n' +
    '\n' +
    'SECTION BOUNDARIES — when the current section looks finished, do NOT move on yet. First verify it:\n' +
    '  - re-read that section\'s goals and acceptance criteria in {roadmapFile};\n' +
    '  - check the completed reports and the git history actually satisfy every one of them;\n' +
    '  - confirm nothing was silently dropped, stubbed, or deferred along the way.\n' +
    'If anything is missing, the next task is to finish it — the section is not done. Only when the section is ' +
    'genuinely complete, write "Status: PHASE_COMPLETE" to {taskFile} together with a short summary of what the ' +
    'section delivered and how you verified it, so the human can review the boundary.\n' +
    'After the human resumes you will be asked to plan again. If {taskFile} still holds a "PHASE_COMPLETE" marker ' +
    'at that point, it has already been reviewed and approved — do NOT restate it. Read {roadmapFile} afresh, pick ' +
    'up the next unfinished section, and replace {taskFile} with the first task of that section.',
};

/** Protocol file locations, relative to project root. */
export const DEFAULT_FILES = {
  task: 'tasks/current.md',
  coderReport: 'reports/current.md',
  testSpec: 'tests/current.md',
  testReport: 'tests/report.md',
  // Optional: the long-range plan the orchestrator breaks into tasks. When
  // set, the roadmap addendum is appended to the orchestrator prompt and the
  // pipeline asks it to plan the next section after a phase gate is resumed.
  roadmap: '',
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
 *   streamAgentOutput: boolean,
 *   agents: {coder: AgentConfig, tester: AgentConfig, orchestrator: AgentConfig},
 *   git: {enabled: boolean, validateCoderCommit: boolean, pullBeforeCycle: boolean, pushAfterCommit: boolean},
 *   remote: {bind: string, port: number, heartbeatIntervalMs: number, heartbeatTimeoutMs: number,
 *            pollTimeoutMs: number, redeliverMs: number, dispatchGraceMinutes: number,
 *            allowPublicClients: boolean, autoCommitTaskFiles: boolean,
 *            includeFailureOutput: boolean, failureOutputChars: number,
 *            streamAgentOutputToOrchestrator: boolean, outputFlushMs: number, outputBufferLines: number},
 *   planNextOnResume: boolean,
 *   prompts: {coder: string, tester: string, orchestrator: string, orchestratorRoadmap: string},
 *   files: {task: string, coderReport: string, testSpec: string, testReport: string, roadmap: string},
 * }} Config
 */

/** @param {string} command @param {Partial<AgentConfig>} [over] @returns {AgentConfig} */
function agentDefaults(command, over = {}) {
  return {
    command,
    // "-p" puts claude CLI into non-interactive print mode; the prompt itself
    // is piped via stdin to avoid shell-quoting problems on Windows.
    // stream-json makes progress visible while the agent works (plain -p
    // prints almost everything only at the end); the pipeline never parses
    // agent stdout, so the format is purely for humans watching.
    args: ['-p', '--verbose', '--output-format', 'stream-json'],
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
    // Mirror locally-run agent output into the pipeline terminal (it is
    // always captured to .pipeline/logs/ regardless).
    streamAgentOutput: true,
    // After a human resumes a phase-complete gate the pipeline would other-
    // wise sit idle waiting for someone to write the next task by hand. With
    // this on, it asks the orchestrator to plan the next roadmap section.
    planNextOnResume: true,
    agents: {
      coder: agentDefaults('claude'),
      tester: agentDefaults('claude'),
      // Antigravity differs from claude in two ways that matter here:
      //   * its "-p" TAKES the prompt as its value, so -p must come last and
      //     the prompt is passed as an argument, not on stdin;
      //   * it enforces its own --print-timeout (5m by default), separate
      //     from timeoutMinutes below.
      // Permission prompts are skipped because headless mode cannot answer
      // them; the orchestrator only reads reports and writes two markdown
      // files, and that narrow remit is spelled out in its prompt. Drop the
      // flag (and add allow-rules in Antigravity's own settings.json) if you
      // would rather gate it per tool.
      orchestrator: agentDefaults('agy', {
        args: ['--dangerously-skip-permissions', '--print-timeout', '20m', '-p'],
        promptVia: 'arg',
        timeoutMinutes: 30,
      }),
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
      autoCommitTaskFiles: true, // commit+push the task protocol files before dispatching
      // On a FAILED run only, let the worker send back the tail of the
      // agent's output so the human gate can explain itself without a trip
      // to the other machine. Successful runs never send output. Set false
      // to keep every byte of agent output on the machine that produced it.
      includeFailureOutput: true,
      failureOutputChars: 2000,
      // Live agent output for the dashboard feed. This sends agent stdout
      // across the LAN while a run is in progress; set false to keep every
      // byte on the machine that produced it (gates still work, you just
      // watch the worker's own terminal instead).
      streamAgentOutputToOrchestrator: true,
      outputFlushMs: 500,
      outputBufferLines: 2000,
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
  for (const key of /** @type {const} */ ([
    'humanGateOnPhaseComplete', 'skipTestingIfNoTestSpec', 'streamAgentOutput', 'planNextOnResume',
  ])) {
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
  if (typeof raw.prompts?.orchestratorRoadmap === 'string') cfg.prompts.orchestratorRoadmap = raw.prompts.orchestratorRoadmap;
  if (raw.git && typeof raw.git === 'object') {
    for (const key of /** @type {const} */ (['enabled', 'validateCoderCommit', 'pullBeforeCycle', 'pushAfterCommit'])) {
      if (typeof raw.git[key] === 'boolean') cfg.git[key] = raw.git[key];
    }
  }
  if (raw.remote && typeof raw.remote === 'object') {
    if (typeof raw.remote.bind === 'string' && raw.remote.bind.trim() !== '') cfg.remote.bind = raw.remote.bind;
    for (const key of /** @type {const} */ ([
      'port', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'pollTimeoutMs', 'redeliverMs', 'dispatchGraceMinutes',
      'failureOutputChars', 'outputFlushMs', 'outputBufferLines',
    ])) {
      if (typeof raw.remote[key] === 'number' && raw.remote[key] >= 0) cfg.remote[key] = raw.remote[key];
    }
    for (const key of /** @type {const} */ ([
      'allowPublicClients', 'autoCommitTaskFiles', 'includeFailureOutput', 'streamAgentOutputToOrchestrator',
    ])) {
      if (typeof raw.remote[key] === 'boolean') cfg.remote[key] = raw.remote[key];
    }
  }
  if (raw.files && typeof raw.files === 'object') {
    for (const key of /** @type {const} */ (['task', 'coderReport', 'testSpec', 'testReport'])) {
      if (typeof raw.files[key] === 'string' && raw.files[key].trim() !== '') cfg.files[key] = raw.files[key];
    }
    // roadmap is optional, so an empty string is a meaningful value here.
    if (typeof raw.files.roadmap === 'string') cfg.files.roadmap = raw.files.roadmap.trim();
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
