// In-memory ring buffer of agent output lines, for the dashboard feed.
//
// Fed by locally-run agents and by AGENT_OUTPUT messages from the worker, so
// the coder, tester and orchestrator all appear in one place. Deliberately
// memory-only: nothing here is written to state.json or to the pipeline log,
// and it is dropped when the orchestrator exits.

import { formatAgentLine } from './agent-stream.js';

export class OutputBus {
  /** @param {{maxLines?: number}} [opts] */
  constructor({ maxLines = 2000 } = {}) {
    this.maxLines = maxLines;
    /** @type {{seq: number, at: string, role: string, text: string}[]} */
    this.lines = [];
    this.seq = 0;
    /** Partial trailing line per role, awaiting its newline. @type {Map<string, string>} */
    this.partial = new Map();
  }

  /**
   * Append raw agent output. Only complete lines are published; a trailing
   * fragment is held until the rest arrives (or flush() is called).
   * @param {string} role
   * @param {string} chunk
   */
  append(role, chunk) {
    if (typeof chunk !== 'string' || chunk === '') return;
    const buf = (this.partial.get(role) ?? '') + chunk;
    const parts = buf.split(/\r?\n/);
    this.partial.set(role, parts.pop() ?? '');
    for (const line of parts) this.publish(role, line);
  }

  /** Publish any held fragment for a role (call when its agent exits). @param {string} role */
  flush(role) {
    const rest = this.partial.get(role);
    this.partial.delete(role);
    if (rest && rest.trim() !== '') this.publish(role, rest);
  }

  /** @param {string} role @param {string} line */
  publish(role, line) {
    const at = new Date().toISOString();
    for (const text of formatAgentLine(line)) {
      this.lines.push({ seq: ++this.seq, at, role, text });
    }
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }

  /**
   * Lines newer than `since`. Returns `dropped: true` when the cursor has
   * fallen off the back of the ring, so the client can restart cleanly
   * instead of silently missing output.
   * @param {number} since
   * @param {number} [limit]
   */
  since(since, limit = 500) {
    const oldest = this.lines.length ? this.lines[0].seq : this.seq;
    const dropped = since > 0 && since < oldest - 1;
    const from = dropped ? [...this.lines] : this.lines.filter((l) => l.seq > since);
    const slice = from.slice(-limit);
    return { lines: slice, cursor: slice.length ? slice[slice.length - 1].seq : Math.max(since, this.seq), dropped };
  }

  /** Note a role boundary in the feed. @param {string} role @param {string} text */
  mark(role, text) {
    this.flush(role);
    this.lines.push({ seq: ++this.seq, at: new Date().toISOString(), role, text: `— ${text} —` });
    if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
  }

  clear() {
    this.lines = [];
    this.partial.clear();
  }
}
