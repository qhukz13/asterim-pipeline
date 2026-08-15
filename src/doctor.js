// "asterim-pipeline doctor" — fast preflight for the machine you run it on.
//
// Answers, in seconds rather than a full pipeline cycle: is this a git repo
// with a usable remote, are the configured agent commands actually on PATH,
// and — the failure that bites hardest — can the agent WRITE a file when run
// headless, or will its file-write be denied?

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PIPELINE_DIR } from './config.js';
import { runAgent } from './agents.js';
import * as gitx from './git.js';

const PROBE_REL = `${PIPELINE_DIR}/permission-probe.md`;
const PROBE_TOKEN = 'ASTERIM_PIPELINE_WRITE_OK';

/** @typedef {{ok: boolean|null, label: string, detail: string}} Check */

/** @param {string} command */
function resolveCommand(command) {
  const which = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(which, [command], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0) return null;
  return (res.stdout ?? '').split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.pipeline', 'dist', 'build', 'coverage', '.turbo', '.next']);

/**
 * Look for a file with the same basename in another immediate subdirectory
 * of the project root (e.g. configured test/report.md missing while
 * tests/report.md exists). Returns a repo-relative path, or null.
 * @param {string} root
 * @param {string} rel
 */
function findSameNameElsewhere(root, rel) {
  const base = path.basename(rel);
  const ownDir = path.dirname(rel).replace(/\\/g, '/');
  /** @type {import('node:fs').Dirent[]} */
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name === ownDir) continue;
    if (fs.existsSync(path.join(root, e.name, base))) return `${e.name}/${base}`;
  }
  return null;
}

/**
 * @param {string} root
 * @param {import('./config.js').Config} cfg
 * @param {{probe?: boolean, roles?: ('coder'|'tester')[], logger: import('./logger.js').Logger}} opts
 * @returns {Promise<{checks: Check[], ok: boolean}>}
 */
export async function doctor(root, cfg, opts) {
  /** @type {Check[]} */
  const checks = [];
  /** @param {boolean|null} ok @param {string} label @param {string} detail */
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  // --- repository ---
  const isRepo = gitx.isRepo(root);
  add(isRepo, 'git repository', isRepo ? root : `${root} is not a git repository`);
  if (isRepo) {
    const remote = gitx.git(root, ['remote', '-v']).stdout;
    const upstream = gitx.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    add(
      remote !== '' ? upstream.ok : null,
      'git remote / upstream',
      remote === ''
        ? 'no remote configured (fine for single-machine mode; required for distributed mode)'
        : upstream.ok
          ? `tracking ${upstream.stdout}`
          : 'branch has no upstream — run: git push -u origin <branch> (required for distributed mode)',
    );
    const dirty = gitx.changedPaths(root).filter((p) => !p.startsWith(`${PIPELINE_DIR}/`));
    add(dirty.length === 0 ? true : null, 'working tree', dirty.length === 0 ? 'clean' : `${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ' …' : ''}`);
  }

  // --- protocol files ---
  // The trap this catches: a repo that uses tests/ while the config says
  // test/ (or reports/ vs report/). The pipeline then watches a file nobody
  // writes, and every cycle stalls on a "missing/stale report" gate.
  for (const [key, rel] of Object.entries(cfg.files)) {
    const abs = path.resolve(root, rel);
    if (fs.existsSync(abs)) {
      add(true, `protocol file (${key})`, `${rel} exists`);
      continue;
    }
    const elsewhere = findSameNameElsewhere(root, rel);
    if (elsewhere) {
      add(false, `protocol file (${key})`, `${rel} does NOT exist, but ${elsewhere} does — set files.${key} in .pipeline/config.json (and use the same value on every machine)`);
    } else {
      const dirOk = fs.existsSync(path.dirname(abs));
      add(null, `protocol file (${key})`, `${rel} not written yet${dirOk ? '' : ` (${path.dirname(rel)}/ will be created on start)`}`);
    }
  }

  // --- agent commands ---
  for (const role of /** @type {const} */ (['coder', 'tester', 'orchestrator'])) {
    const cmd = cfg.agents[role].command;
    const found = resolveCommand(cmd);
    add(found != null, `${role} command`, found != null ? `${cmd} -> ${found}` : `"${cmd}" not found on PATH`);
  }

  // --- headless write permission probe ---
  const roles = opts.roles ?? [];
  for (const role of roles) {
    const abs = path.resolve(root, PROBE_REL);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.rmSync(abs, { force: true });
    } catch {
      /* handled by the result check */
    }
    const prompt =
      `Write a file at ${PROBE_REL} whose entire contents are exactly this one line:\n` +
      `${PROBE_TOKEN}\n` +
      'Do not create, modify, or delete any other file. Do not run any other command. Then stop.';
    opts.logger.info(`[doctor] probing ${role} headless file-write permission…`);
    const res = await runAgent(role, cfg.agents[role], prompt, root, {});
    const wrote = fs.existsSync(abs) && fs.readFileSync(abs, 'utf8').includes(PROBE_TOKEN);
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* leave it; harmless and git-ignored */
    }
    add(
      wrote,
      `${role} can write files headless`,
      wrote
        ? 'write succeeded'
        : res.spawnError
          ? `agent failed to launch: ${res.spawnError}`
          : `agent exited (code ${res.code}) without writing the probe file — file writes are most likely denied in headless mode. See ${path.relative(root, res.logFile)} and the README "Agent permissions" section.`,
    );
  }

  const ok = checks.every((c) => c.ok !== false);
  return { checks, ok };
}

/** @param {Check[]} checks */
export function formatChecks(checks) {
  return checks
    .map((c) => `${c.ok === true ? ' ok ' : c.ok === false ? 'FAIL' : 'warn'}  ${c.label.padEnd(30)} ${c.detail}`)
    .join('\n');
}
