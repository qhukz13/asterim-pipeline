// Read-only-ish git helpers. The pipeline itself only ever runs:
//   rev-parse, status --porcelain, pull --ff-only, push (no --force, ever).
// It never runs reset/clean/checkout and never deletes files.

import { spawnSync } from 'node:child_process';

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ok: boolean, stdout: string, stderr: string}}
 */
export function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
}

/** @param {string} cwd */
export function isRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout === 'true';
}

/** @param {string} cwd @returns {string|null} */
export function headSha(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout : null; // null on empty repo (no commits yet)
}

/** True if the working tree has uncommitted changes. @param {string} cwd */
export function hasUncommittedChanges(cwd) {
  const r = git(cwd, ['status', '--porcelain']);
  return r.ok && r.stdout !== '';
}

/**
 * Paths with uncommitted changes (staged, unstaged, or untracked),
 * normalized to forward slashes.
 * @param {string} cwd
 * @returns {string[]}
 */
export function changedPaths(cwd) {
  // -uall lists untracked files individually instead of collapsing them into
  // directories, so protocol files can be filtered out precisely.
  const r = git(cwd, ['status', '--porcelain', '-uall']);
  if (!r.ok || r.stdout === '') return [];
  return r.stdout
    .split('\n')
    .map((line) => {
      let p = line.slice(3).trim();
      const arrow = p.indexOf(' -> ');
      if (arrow !== -1) p = p.slice(arrow + 4); // rename: keep new path
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      return p.replace(/\\/g, '/');
    })
    .filter((p) => p !== '');
}

/** Fast-forward-only pull. @param {string} cwd */
export function pullFfOnly(cwd) {
  return git(cwd, ['pull', '--ff-only']);
}

/** Plain push (never force). @param {string} cwd */
export function push(cwd) {
  return git(cwd, ['push']);
}
