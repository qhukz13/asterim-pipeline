// LAN protocol: message envelope, validation, and token comparison.
//
// Transport is plain HTTP on the local network (see README "Distributed
// mode"): the orchestrator listens, the worker dials out and long-polls for
// commands. WebSocket was considered but Node has no built-in WebSocket
// *server*; long-polling keeps the project dependency-free and makes
// reconnects trivial (every request is independent).
//
// Every message is a JSON object with a common envelope:
//   { v: 1, id: "<uuid>", ts: "<iso>", type: "<TYPE>", ...fields }

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

export const PROTO_VERSION = 1;

/** All message types on the wire. */
export const MSG = /** @type {const} */ ({
  // worker -> orchestrator
  WORKER_REGISTER: 'WORKER_REGISTER',
  WORKER_HEARTBEAT: 'WORKER_HEARTBEAT',
  WORKER_POLL: 'WORKER_POLL',
  CODER_RESULT: 'CODER_RESULT',
  TESTER_RESULT: 'TESTER_RESULT',
  WORKER_GIT_CONFLICT: 'WORKER_GIT_CONFLICT',
  ERROR: 'ERROR',
  // orchestrator -> worker
  REGISTERED: 'REGISTERED',
  ACK: 'ACK',
  RUN_CODER: 'RUN_CODER',
  RUN_TESTER: 'RUN_TESTER',
  PAUSE: 'PAUSE',
  STOP: 'STOP',
  NONE: 'NONE',
});

/** Required string fields per inbound (worker -> orchestrator) type. */
const REQUIRED = /** @type {Record<string, string[]>} */ ({
  WORKER_REGISTER: ['workerId'],
  WORKER_HEARTBEAT: ['workerId', 'sessionId'],
  WORKER_POLL: ['workerId', 'sessionId'],
  CODER_RESULT: ['workerId', 'sessionId', 'dispatchId', 'taskId'],
  TESTER_RESULT: ['workerId', 'sessionId', 'dispatchId', 'taskId'],
  WORKER_GIT_CONFLICT: ['workerId', 'sessionId', 'dispatchId', 'stage'],
  ERROR: ['workerId', 'sessionId', 'message'],
});

/**
 * Build a protocol message with the standard envelope.
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 */
export function makeMsg(type, fields = {}) {
  return { v: PROTO_VERSION, id: randomUUID(), ts: new Date().toISOString(), type, ...fields };
}

/**
 * Strictly validate an inbound worker message. Returns an error string or
 * null when the message is well-formed.
 * @param {unknown} obj
 * @returns {string|null}
 */
export function validateWorkerMessage(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return 'message is not an object';
  const m = /** @type {Record<string, unknown>} */ (obj);
  if (m.v !== PROTO_VERSION) return `unsupported protocol version ${String(m.v)}`;
  if (typeof m.id !== 'string' || m.id === '') return 'missing message id';
  if (typeof m.ts !== 'string' || Number.isNaN(Date.parse(m.ts))) return 'missing or invalid timestamp';
  if (typeof m.type !== 'string' || !(m.type in REQUIRED)) return `unknown or unexpected message type "${String(m.type)}"`;
  for (const field of REQUIRED[m.type]) {
    if (typeof m[field] !== 'string' || m[field] === '') return `missing field "${field}" for ${m.type}`;
  }
  return null;
}

/**
 * Constant-time token comparison. Both inputs are hashed first so the
 * comparison never leaks length information and always compares equal-sized
 * buffers.
 * @param {string} a
 * @param {string} b
 */
export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Is this address the local machine itself? (Used to gate the read-only
 * dashboard, which is served without a token to the PC's own browser only.)
 * @param {string|undefined} addr
 */
export function isLoopbackAddress(addr) {
  if (!addr) return false;
  let a = addr;
  if (a.startsWith('::ffff:')) a = a.slice(7);
  return a === '::1' || a.startsWith('127.');
}

/**
 * Is this remote address on the local machine or a private LAN range?
 * Used to refuse connections that are not LAN-local (defense in depth on
 * top of token auth; can be disabled via remote.allowPublicClients).
 * @param {string|undefined} addr
 */
export function isPrivateAddress(addr) {
  if (!addr) return false;
  let a = addr;
  if (a.startsWith('::ffff:')) a = a.slice(7); // IPv4-mapped IPv6
  if (a === '::1') return true;
  if (a === 'fe80' || a.startsWith('fe80:')) return true; // link-local v6
  const low = a.toLowerCase();
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // unique-local v6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  if (o1 === 127 || o1 === 10) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 169 && o2 === 254) return true; // link-local v4
  return false;
}

/** Cap for report file content transmitted over LAN (bytes of UTF-8 text). */
export const MAX_REPORT_BYTES = 256 * 1024;

/**
 * Truncate report content to the transmission cap.
 * @param {string|null} text
 */
export function capReport(text) {
  if (text == null) return null;
  if (Buffer.byteLength(text, 'utf8') <= MAX_REPORT_BYTES) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, MAX_REPORT_BYTES);
  return buf.toString('utf8') + '\n\n[truncated by pipeline: report exceeded 256 KiB]\n';
}
