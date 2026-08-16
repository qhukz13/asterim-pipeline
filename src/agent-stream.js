// Turn `claude --output-format stream-json` events into readable one-liners.
//
// The pipeline never depends on agent stdout for correctness — reports are
// the protocol. This is purely for humans watching the dashboard, so it is
// deliberately forgiving: anything unrecognized is passed through rather
// than dropped, and a malformed line is never fatal.

/** Inputs whose value is worth showing next to a tool name, in priority order. */
const SUMMARY_KEYS = ['file_path', 'command', 'path', 'pattern', 'url', 'notebook_path', 'prompt', 'description', 'query'];

/** @param {unknown} v */
function short(v, max = 120) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/** @param {Record<string, any>} input */
function summarizeToolInput(input) {
  if (input == null || typeof input !== 'object') return '';
  for (const key of SUMMARY_KEYS) {
    if (typeof input[key] === 'string' && input[key] !== '') return short(input[key]);
  }
  const keys = Object.keys(input);
  return keys.length ? short(`{${keys.join(', ')}}`) : '';
}

/** @param {number|undefined} ms */
function secs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/**
 * Extract the readable content of one stream-json event.
 * @param {Record<string, any>} ev
 * @returns {string[]}
 */
function renderEvent(ev) {
  switch (ev.type) {
    case 'system': {
      if (ev.subtype !== 'init') return [`· ${short(ev.subtype ?? 'system')}`];
      const bits = [`model ${short(ev.model)}`];
      if (Array.isArray(ev.tools)) bits.push(`${ev.tools.length} tools`);
      if (ev.permissionMode) bits.push(`permissions: ${short(ev.permissionMode)}`);
      return [`· session start — ${bits.join(' · ')}`];
    }
    case 'assistant': {
      /** @type {string[]} */
      const out = [];
      const content = ev.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          for (const line of block.text.split('\n')) {
            if (line.trim() !== '') out.push(line.trimEnd());
          }
        } else if (block?.type === 'tool_use') {
          const arg = summarizeToolInput(block.input);
          out.push(`▸ ${short(block.name, 40)}${arg ? '  ' + arg : ''}`);
        }
        // 'thinking' blocks are intentionally skipped: high volume, low signal.
      }
      if (typeof ev.error === 'string' && ev.error !== '') out.push(`✗ ${short(ev.error)}`);
      return out;
    }
    case 'user': {
      // Only surface tool failures; successful results are far too noisy.
      /** @type {string[]} */
      const out = [];
      const content = ev.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block?.type === 'tool_result' && block.is_error) {
          const body = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((/** @type {any} */ c) => c?.text ?? '').join(' ')
              : block.content;
          out.push(`  ✗ ${short(body, 200)}`);
        }
      }
      return out;
    }
    case 'result': {
      /** @type {string[]} */
      const out = [];
      const bits = [];
      if (ev.duration_ms) bits.push(secs(ev.duration_ms));
      if (typeof ev.num_turns === 'number') bits.push(`${ev.num_turns} turns`);
      if (typeof ev.total_cost_usd === 'number' && ev.total_cost_usd > 0) bits.push(`$${ev.total_cost_usd.toFixed(2)}`);
      const tail = bits.length ? ` — ${bits.join(' · ')}` : '';
      out.push(ev.is_error ? `✗ failed${tail}` : `✓ finished${tail}`);
      // The single most useful thing when a headless run does nothing.
      const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
      if (denials.length) {
        const names = denials.map((/** @type {any} */ d) => short(d?.tool_name ?? d?.tool ?? d, 40));
        out.push(`⚠ permission denied: ${[...new Set(names)].join(', ')}`);
      }
      if (ev.is_error && typeof ev.result === 'string' && ev.result !== '') out.push(`  ${short(ev.result, 300)}`);
      return out;
    }
    case 'stream_event':
      return []; // partial deltas: ignored, the assistant event carries the text
    default:
      return [`· ${short(ev.type ?? JSON.stringify(ev), 160)}`];
  }
}

/**
 * Format one raw output line.
 * @param {string} line
 * @returns {string[]} zero or more display lines
 */
export function formatAgentLine(line) {
  const trimmed = line.replace(/\r$/, '');
  if (trimmed.trim() === '') return [];
  if (!trimmed.startsWith('{')) return [trimmed]; // plain text agent (e.g. agy)
  /** @type {Record<string, any>} */
  let ev;
  try {
    ev = JSON.parse(trimmed);
  } catch {
    return [trimmed]; // not JSON after all; show it verbatim
  }
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return [trimmed];
  try {
    return renderEvent(ev);
  } catch {
    return [trimmed]; // never let a surprising shape break the feed
  }
}

/**
 * Format a whole blob of agent output (e.g. a log tail).
 * @param {string} text
 * @returns {string}
 */
export function formatAgentOutput(text) {
  return text
    .split('\n')
    .flatMap((l) => formatAgentLine(l))
    .join('\n');
}
