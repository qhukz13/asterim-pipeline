// Concise append-only log at .pipeline/pipeline.log, mirrored to the console.

import fs from 'node:fs';
import path from 'node:path';
import { PIPELINE_DIR } from './config.js';

/**
 * @typedef {{info: (msg: string) => void, warn: (msg: string) => void,
 *            error: (msg: string) => void, banner: (lines: string[]) => void,
 *            file: string}} Logger
 */

/**
 * @param {string} projectRoot
 * @param {{quiet?: boolean}} [opts]
 * @returns {Logger}
 */
export function createLogger(projectRoot, opts = {}) {
  const dir = path.join(projectRoot, PIPELINE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'pipeline.log');

  /** @param {string} level @param {string} msg */
  function write(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${msg}`;
    try {
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      // Logging must never take the pipeline down.
    }
    if (!opts.quiet) {
      (level === 'ERROR' ? console.error : console.log)(line);
    }
  }

  return {
    file,
    info: (msg) => write('INFO', msg),
    warn: (msg) => write('WARN', msg),
    error: (msg) => write('ERROR', msg),
    banner(lines) {
      const bar = '='.repeat(50);
      const block = [bar, ...lines, bar].join('\n');
      try {
        fs.appendFileSync(file, block + '\n', 'utf8');
      } catch {
        /* ignore */
      }
      if (!opts.quiet) {
          console.log('\n' + block + '\n');
      }
    },
  };
}
