// Data extraction for the dashboard. Filesystem reads only, kept separate
// from the HTML so the interesting parts can be unit-tested.
//
// Everything here is READ-ONLY and local to the orchestrator machine: no
// protocol messages, no agent transcripts, no secrets.

import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_DIR } from './config.js';
import { readState } from './store.js';
import { git } from './git.js';

const LOG_TAIL_LINES = 60;
const LOG_TAIL_BYTES = 256 * 1024;
const BODY_PREVIEW_CHARS = 6000;
const MAX_TRANSITIONS = 14;
const SEP = String.fromCharCode(31); // unit separator: safe field delimiter for git --format

/** Metadata lines the agents write for the parser; not prose. */
const META_LINE = /^[ \t>*_\-#]*(?:task[-_ ]?id|phase|status|result|no[-_ ]?code[-_ ]?changes)[ \t]*\*{0,2}[ \t]*[:=].*$/gim;

/** Section labels that are not a task title. */
const GENERIC_HEADING = /^(?:objective|objectives|summary|overview|goal|goals|description|context|task|background|purpose|scope|details|problem)\b[ \t]*:?$/i;

/** @param {string} root @param {string} rel */
function readFileSafe(root, rel) {
  try {
    return fs.readFileSync(path.resolve(root, rel), 'utf8');
  } catch {
    return null;
  }
}

/** @param {string} s @param {number} max */
function clip(s, max) {
  return s.length <= max ? s : s.slice(0, max) + `\n\n… (${s.length - max} more characters — open the file for the rest)`;
}

/**
 * Turn a protocol markdown file into something readable at a glance: a
 * title, a one-paragraph gist, and any acceptance-criteria bullets.
 * @param {string|null} text
 */
export function summarizeMarkdown(text) {
  if (text == null || text.trim() === '') return null;
  const withoutMeta = text.replace(META_LINE, '').trim();

  const headingMatch = /^#{1,6}[ \t]+(.+?)[ \t]*#*$/m.exec(withoutMeta);
  const heading = headingMatch ? headingMatch[1].trim().replace(/[*`]/g, '') : null;
  // A section label like "## Objective" is not a title — the real subject is
  // the text underneath it.
  let title = heading != null && !GENERIC_HEADING.test(heading) ? heading : null;

  const paragraphs = withoutMeta
    .split(/\r?\n/)
    .filter((l) => !/^#{1,6}[ \t]/.test(l) && !/^[ \t]*[-*_]{3,}[ \t]*$/.test(l))
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim().replace(/\s+/g, ' ').replace(/\*\*/g, ''))
    .filter((p) => p !== '');

  let rest = paragraphs;
  if (title == null && paragraphs.length > 0) {
    // Short opening line reads as a title; a long one is prose, so keep it
    // as the summary and derive a clipped title from it.
    if (paragraphs[0].length <= 120) {
      title = paragraphs[0];
      rest = paragraphs.slice(1);
    } else {
      title = paragraphs[0].slice(0, 80) + '…';
    }
  }
  const summary = (rest[0] ?? '').slice(0, 400);

  // Acceptance criteria: bullets under a heading that mentions them.
  /** @type {string[]} */
  const criteria = [];
  let inCriteria = false;
  for (const line of withoutMeta.split(/\r?\n/)) {
    const heading = /^#{1,6}[ \t]+(.+)$/.exec(line);
    if (heading) {
      inCriteria = /acceptance|criteria|definition of done|requirement|verification/i.test(heading[1]);
      continue;
    }
    const bullet = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?(.+?)[ \t]*$/.exec(line);
    if (inCriteria && bullet) {
      const item = bullet[1].replace(/\*\*/g, '').trim();
      if (item !== '' && criteria.length < 10) criteria.push(item);
    }
  }

  return {
    title,
    summary,
    criteria,
    body: clip(withoutMeta, BODY_PREVIEW_CHARS),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

/**
 * Recent state transitions with timestamps, parsed from our own log lines
 * ("... [INFO] state A -> B"). Gives the UI a timeline without adding any
 * new persisted state.
 * @param {string[]} logLines
 */
export function parseTransitions(logLines) {
  /** @type {{at: string, from: string, to: string}[]} */
  const out = [];
  for (const line of logLines) {
    const m = /^(\S+) \[\w+\] state ([A-Z_]+) -> ([A-Z_]+)/.exec(line);
    if (m) out.push({ at: m[1], from: m[2], to: m[3] });
  }
  return out.slice(-MAX_TRANSITIONS);
}

/** @param {string} root */
function readLogTail(root) {
  try {
    const lf = path.join(root, PIPELINE_DIR, 'pipeline.log');
    const size = fs.statSync(lf).size;
    const start = Math.max(0, size - LOG_TAIL_BYTES);
    const fd = fs.openSync(lf, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').split(/\r?\n/).filter((l) => l !== '');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

const GIT_CACHE_MS = 10_000;
/** @type {{root: string, at: number, value: any}|null} */
let gitCache = null;

/**
 * Git info, memoized: the dashboard polls every 2s and each call would
 * otherwise spawn three git processes per open browser tab.
 * @param {string} root
 */
function gitInfoCached(root) {
  const now = Date.now();
  if (gitCache && gitCache.root === root && now - gitCache.at < GIT_CACHE_MS) return gitCache.value;
  const value = gitInfo(root);
  // Only memoize a real answer: "no repo / no commits yet" is a transient
  // early state that must not be pinned for the cache window.
  if (value != null) gitCache = { root, at: now, value };
  else gitCache = null;
  return value;
}

/** @param {string} root */
function gitInfo(root) {
  try {
    const head = git(root, ['log', '-1', `--format=%h${SEP}%s${SEP}%an${SEP}%aI`]);
    if (!head.ok || head.stdout === '') return null;
    const [sha, subject, author, when] = head.stdout.split(SEP);
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const recent = git(root, ['log', '-5', `--format=%h${SEP}%s${SEP}%aI`]);
    return {
      branch: branch.ok ? branch.stdout : null,
      head: { sha, subject, author, when },
      recent: recent.ok
        ? recent.stdout
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => {
              const [s, sub, at] = l.split(SEP);
              return { sha: s, subject: sub, at };
            })
        : [],
    };
  } catch {
    return null;
  }
}

/**
 * Full dashboard snapshot.
 * @param {string} root
 * @param {import('./config.js').Config['files']} files
 * @param {{agents?: Record<string, string>, port?: number|null}} [meta] non-secret config summary
 */
export function dashboardData(root, files, meta = {}) {
  const { state } = readState(root);
  /** @type {any[]} */
  let workers = [];
  try {
    const wf = path.join(root, PIPELINE_DIR, 'workers.json');
    if (fs.existsSync(wf)) workers = JSON.parse(fs.readFileSync(wf, 'utf8')).workers ?? [];
  } catch {
    /* partial data is fine */
  }
  const log = readLogTail(root);
  const transitions = parseTransitions(log);

  return {
    now: new Date().toISOString(),
    root,
    state,
    workers,
    log: log.slice(-LOG_TAIL_LINES),
    transitions,
    // When the current state was entered, so the UI can show elapsed time
    // for the step that is running right now.
    stateSince: [...transitions].reverse().find((t) => t.to === state.state)?.at ?? state.updatedAt ?? null,
    task: summarizeMarkdown(readFileSafe(root, files.task)),
    coderReport: summarizeMarkdown(readFileSafe(root, files.coderReport)),
    testSpec: summarizeMarkdown(readFileSafe(root, files.testSpec)),
    testReport: summarizeMarkdown(readFileSafe(root, files.testReport)),
    git: gitInfoCached(root),
    config: { files, agents: meta.agents ?? {}, port: meta.port ?? null },
  };
}
