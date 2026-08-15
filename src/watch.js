// Debounced file watching built on fs.watch (ReadDirectoryChangesW on
// Windows, inotify/FSEvents elsewhere) — no aggressive polling.
//
// The watcher only reports "file X settled after change activity". Content
// validation (did the bytes actually change vs. the last processed hash) is
// the runner's job, so a timestamp-only rewrite never triggers an agent.

import fs from 'node:fs';
import path from 'node:path';

export class FileWatcher {
  /**
   * @param {string} root project root
   * @param {string[]} relPaths relative file paths to watch
   * @param {number} debounceMs
   * @param {(relPath: string) => void} onSettled called once per burst of changes
   */
  constructor(root, relPaths, debounceMs, onSettled) {
    this.root = root;
    this.debounceMs = debounceMs;
    this.onSettled = onSettled;
    /** @type {Map<string, Set<string>>} dir -> basenames of interest */
    this.byDir = new Map();
    /** @type {Map<string, string>} dir+basename -> relPath */
    this.relOf = new Map();
    for (const rel of relPaths) {
      const abs = path.resolve(root, rel);
      const dir = path.dirname(abs);
      const base = path.basename(abs);
      if (!this.byDir.has(dir)) this.byDir.set(dir, new Set());
      this.byDir.get(dir)?.add(base);
      this.relOf.set(path.join(dir, base), rel);
    }
    /** @type {fs.FSWatcher[]} */
    this.watchers = [];
    /** @type {Map<string, NodeJS.Timeout>} */
    this.timers = new Map();
    this.closed = false;
  }

  start() {
    for (const [dir, bases] of this.byDir) {
      fs.mkdirSync(dir, { recursive: true });
      const w = fs.watch(dir, (_event, filename) => {
        if (this.closed || !filename) return;
        // Windows may report 8.3 short names in rare cases; compare case-insensitively.
        for (const base of bases) {
          if (String(filename).toLowerCase() === base.toLowerCase()) {
            this.bump(path.join(dir, base));
            break;
          }
        }
      });
      w.on('error', () => {
        /* a vanished directory just stops producing events; runner has a slow safety tick */
      });
      this.watchers.push(w);
    }
  }

  /** Debounce: (re)arm a timer per file; fire once after quiet period. @param {string} absKey */
  bump(absKey) {
    const t = this.timers.get(absKey);
    if (t) clearTimeout(t);
    this.timers.set(
      absKey,
      setTimeout(() => {
        this.timers.delete(absKey);
        if (this.closed) return;
        const rel = this.relOf.get(absKey);
        if (rel) this.onSettled(rel);
      }, this.debounceMs),
    );
  }

  close() {
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
