// Runner lock + control channel. Other CLI invocations (pause/resume/stop)
// talk to a running pipeline by writing .pipeline/control.json; the runner
// consumes (deletes) it. Local files only — no sockets, no services.

import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_DIR } from './config.js';
import { pidAlive } from './agents.js';

/** @param {string} root */
export function lockPath(root) {
  return path.join(root, PIPELINE_DIR, 'runner.lock');
}

/** @param {string} root */
export function controlPath(root) {
  return path.join(root, PIPELINE_DIR, 'control.json');
}

/**
 * @param {string} root
 * @returns {{pid: number, startedAt: string}|null} live lock info, or null
 */
export function readLiveLock(root) {
  const file = lockPath(root);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw?.pid === 'number' && pidAlive(raw.pid)) return raw;
  } catch {
    /* missing or unreadable -> not locked */
  }
  return null;
}

/**
 * Acquire the runner lock. Throws if another live runner holds it; silently
 * replaces a stale lock (dead PID).
 * @param {string} root
 */
export function acquireLock(root) {
  const live = readLiveLock(root);
  if (live) throw new Error(`pipeline already running (pid ${live.pid}, started ${live.startedAt})`);
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', 'utf8');
}

/** @param {string} root */
export function releaseLock(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(root), 'utf8'));
    if (raw?.pid === process.pid) fs.unlinkSync(lockPath(root));
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
