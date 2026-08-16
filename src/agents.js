// Agent process launching. Commands come ONLY from explicit configuration —
// never from anything found inside repository markdown.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { PIPELINE_DIR } from './config.js';

/**
 * Fill {placeholders} in a prompt template.
 * @param {string} template
 * @param {Record<string, string>} vars
 */
export function renderPrompt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? vars[key] : m));
}

/**
 * Minimal cmd.exe-safe quoting for shell fallback on Windows. Only used for
 * simple flag-style args; prompts default to stdin delivery precisely so we
 * never have to shell-quote free-form text.
 * @param {string} arg
 */
function winQuote(arg) {
  if (arg === '') return '""';
  if (!/[\s"&|<>^%]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/%/g, '"%"')}"`;
}

/**
 * @typedef {{code: number|null, timedOut: boolean, spawnError: string|null, pid: number|null, logFile: string}} AgentResult
 */

/**
 * Launch an agent and wait for it to exit. stdout/stderr are captured to
 * .pipeline/logs/<role>-<n>.log for observability.
 *
 * @param {'coder'|'tester'|'orchestrator'} role
 * @param {import('./config.js').AgentConfig} agentCfg
 * @param {string} prompt
 * @param {string} projectRoot
 * @param {{onSpawn?: (pid: number) => void, signal?: AbortSignal,
 *          onOutput?: (chunk: Buffer) => void}} [hooks] onOutput additionally
 *          streams stdout/stderr chunks (they are always written to the log file)
 * @returns {Promise<AgentResult>}
 */
export function runAgent(role, agentCfg, prompt, projectRoot, hooks = {}) {
  const logsDir = path.join(projectRoot, PIPELINE_DIR, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `${role}-${stamp}.log`);

  const args = [...agentCfg.args];
  if (agentCfg.promptVia === 'arg') args.push(prompt);

  return new Promise((resolve) => {
    /** @type {AgentResult} */
    const result = { code: null, timedOut: false, spawnError: null, pid: null, logFile };

    const out = fs.createWriteStream(logFile, { flags: 'a' });
    out.write(`# ${role} launched ${new Date().toISOString()}\n# command: ${agentCfg.command} ${args.join(' ')}\n\n`);

    // Safety interlock for the test suite: a fixture that forgets to pin an
    // agent would otherwise launch the real claude/agy on the developer's
    // machine — with permission prompts skipped. Fail loudly instead.
    if (process.env.ASTERIM_PIPELINE_BLOCK_REAL_AGENTS === '1' && agentCfg.command !== process.execPath) {
      result.spawnError = `refused to launch "${agentCfg.command}": real agents are blocked in this environment (pin a fixture agent in the test config)`;
      out.end(`\n# ${result.spawnError}\n`);
      resolve(result);
      return;
    }

    /** @param {boolean} useShell */
    const doSpawn = (useShell) => {
      const child = useShell
        ? spawn([winQuote(agentCfg.command), ...args.map(winQuote)].join(' '), {
            cwd: projectRoot,
            shell: true,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn(agentCfg.command, args, {
            cwd: projectRoot,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });

      let settled = false;
      /** @type {NodeJS.Timeout|null} */
      let timer = null;

      child.on('error', (err) => {
        // Windows: .cmd/.bat shims cannot be spawned without a shell
        // (EINVAL since CVE-2024-27980); ENOENT if only the shim resolves.
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (!useShell && process.platform === 'win32' && (code === 'EINVAL' || code === 'ENOENT')) {
          doSpawn(true);
          return;
        }
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        result.spawnError = String(err.message ?? err);
        out.end(`\n# spawn error: ${result.spawnError}\n`);
        resolve(result);
      });

      child.on('spawn', () => {
        result.pid = child.pid ?? null;
        if (child.pid != null) hooks.onSpawn?.(child.pid);
        // The agent may exit without reading stdin; never let EPIPE crash us.
        child.stdin.on('error', () => {});
        if (agentCfg.promptVia === 'stdin') child.stdin.write(prompt);
        child.stdin.end();
        if (agentCfg.timeoutMinutes > 0) {
          timer = setTimeout(() => {
            result.timedOut = true;
            killTree(child.pid);
          }, agentCfg.timeoutMinutes * 60_000);
        }
        if (hooks.signal?.aborted) killTree(child.pid);
        else hooks.signal?.addEventListener('abort', () => killTree(child.pid), { once: true });
      });

      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
      if (hooks.onOutput) {
        child.stdout.on('data', hooks.onOutput);
        child.stderr.on('data', hooks.onOutput);
      }

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        result.code = code;
        out.end(`\n# exited ${new Date().toISOString()} code=${code}${result.timedOut ? ' (timed out, killed)' : ''}\n`);
        resolve(result);
      });
    };

    doSpawn(false);
  });
}

/**
 * Kill a process tree (agents may spawn their own children).
 * @param {number|undefined} pid
 */
export function killTree(pid) {
  if (pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    /* already gone */
  }
}

/** Is a PID alive? @param {number|null} pid */
export function pidAlive(pid) {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
