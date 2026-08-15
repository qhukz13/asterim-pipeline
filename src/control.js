// Runner lock + control channel. Other CLI invocations (pause/resume/stop)
// talk to a running pipeline by writing .pipeline/control.json; the runner
// consumes (deletes) it. Local files only — no sockets, no services.

import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_DIR } from './config.js';
import { pidAlive } from './agents.js';

/** @param {string} root @param {string} [name] */
export function lockPath(root, name = 'runner') {
  return path.join(root, PIPELINE_DIR, `${name}.lock`);
}

/** @param {string} root */
export function controlPath(root) {
  return path.join(root, PIPELINE_DIR, 'control.json');
}

/**
 * @param {string} root
 * @param {string} [name]
 * @returns {{pid: number, startedAt: string}|null} live lock info, or null
 */
export function readLiveLock(root, name = 'runner') {
  const file = lockPath(root, name);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.pid === 'number' && pidAlive(raw.pid)) return raw;
  } catch {
    /* missing or unreadable -> not locked */
  }
  return null;
}

/**
 * Acquire a process lock. Throws if another live process holds it; silently
 * replaces a stale lock (dead PID).
 * @param {string} root
 * @param {string} [name]
 */
export function acquireLock(root, name = 'runner') {
  const live = readLiveLock(root, name);
  if (live) throw new Error(`${name} already running (pid ${live.pid}, started ${live.startedAt})`);
  fs.mkdirSync(path.dirname(lockPath(root, name)), { recursive: true });
  fs.writeFileSync(lockPath(root, name), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', 'utf8');
}

/** @param {string} root @param {string} [name] */
export function releaseLock(root, name = 'runner') {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(root, name), 'utf8'));
    if (raw?.pid === process.pid) fs.unlinkSync(lockPath(root, name));
  } catch {
    /* nothing to release */
  }
}

/** @param {string} root @param {'pause'|'resume'|'stop'} command */
export function writeControl(root, command) {
  fs.mkdirSync(path.dirname(controlPath(root)), { recursive: true });
  fs.writeFileSync(controlPath(root), JSON.stringify({ command, ts: new Date().toISOString() }) + '\n', 'utf8');
}

/**
 * Read and consume a pending control command.
 * @param {string} root
 * @returns {'pause'|'resume'|'stop'|null}
 */
export function consumeControl(root) {
  const file = controlPath(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    if (raw?.command === 'pause' || raw?.command === 'resume' || raw?.command === 'stop') return raw.command;
  } catch {
    /* no pending command */
  }
  return null;
}
