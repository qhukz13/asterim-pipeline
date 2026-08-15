# Execution Report — Distributed LAN Worker Architecture

Task-ID: DIST-01
Status: COMPLETE

## What was built

Distributed execution for asterim-pipeline across two LAN machines, layered on
the existing deterministic pipeline without touching the state machine:

- `asterim-pipeline orchestrator` (PC): runs the existing Runner + Antigravity
  locally, listens for one worker, and dispatches coder/tester execution.
- `asterim-pipeline worker` (laptop): a stateless execution node that
  registers with a shared token, long-polls for commands, runs Claude
  coder/tester via the existing `agents.js`, and returns structured results.
- `asterim-pipeline workers`: observability table (Worker ID / Status /
  Agent / Task / Last seen); `status` also shows worker info.
- Local mode (`start`, `run-once`, …) is unchanged and fully regression-tested.

New modules: `src/proto.js` (envelope, validation, constant-time token
compare, LAN-address check), `src/server.js` (orchestrator HTTP listener,
registry, long-poll dispatch, heartbeat/offline detection),
`src/remote.js` (RemoteExecutor bridging Runner ↔ server ↔ git),
`src/worker.js` (worker loop with reconnect/backoff, dedupe, result queue).
Existing modules extended minimally: `runner.js` (remote branch at the single
`launch()` choke point + publish/sync/gate hooks), `config.js` (`remote.*`),
`bin` (new commands + token management), `logger.js` (line tags),
`control.js` (named locks), `status.js` (worker line).

## Design decisions (and one documented interpretation)

1. **HTTP long-poll instead of WebSocket.** The spec allowed either and said
   to prefer WebSocket "if it simplifies persistent connection handling".
   Node has no built-in WebSocket *server*, so WS would have meant a new
   runtime dependency or hand-rolled RFC 6455 framing. Long-polling over
   `node:http` keeps the project at zero runtime dependencies, delivers
   commands immediately, and makes reconnection trivial. All specified
   message types (WORKER_REGISTER, WORKER_HEARTBEAT, RUN_CODER, CODER_RESULT,
   RUN_TESTER, TESTER_RESULT, PAUSE, STOP, ERROR, plus WORKER_GIT_CONFLICT)
   are implemented with the required envelope (version, id, timestamp,
   workerId, authenticated session).
2. **Listener direction (documented ambiguity).** The spec's NETWORK BOUNDARY
   section says "the worker server", but every other requirement (worker
   "connects to the orchestrator", `--host` pointing at the orchestrator,
   "how to discover the orchestrator LAN address", WORKER_REGISTER flowing
   worker→PC) implies the orchestrator listens and the worker dials out.
   Implemented that way; the worker opens no listening socket at all, which
   is also the smaller attack surface. Bind/port/firewall docs cover the
   orchestrator's listener.
3. **Task files travel via git, not LAN.** Before RUN_CODER the orchestrator
   commits `tasks/current.md` + `test/current.md` (additive commit scoped to
   exactly those paths) and pushes, so the worker's `git pull --ff-only`
   sees the task. Disable with `remote.autoCommitTaskFiles: false` (the
   pipeline then gates if the files are uncommitted).
4. **One worker at a time.** The pipeline is sequential, so the server
   accepts a single registered worker (second concurrent workerId → 409);
   re-registration of the same workerId is the reconnect path.

## How each requirement is met

- **Authentication**: 256-bit token generated at first `orchestrator` run
  (`.pipeline/orchestrator.token`, mode 0600, git-ignored along with
  `worker.token` via `.pipeline/.gitignore` `*.token`); Bearer header on
  every request; SHA-256 + `timingSafeEqual` comparison; unauthenticated and
  malformed messages rejected with 401/400 and logged. Worker token comes
  from `--token` > `ASTERIM_PIPELINE_TOKEN` > `.pipeline/worker.token` —
  never from committed config.
- **Idempotency**: at-least-once delivery (redelivery every
  `remote.redeliverMs` until a result arrives) + worker-side dedupe by
  dispatchId (in-flight run ignored, completed results re-sent from cache).
  Verified: an 800 ms coder with 100 ms redelivery executed exactly once.
- **Git safety**: worker does `pull --ff-only` → run → (coder commit) →
  plain `push`. Non-FF pull or rejected push → `WORKER_GIT_CONFLICT` →
  HUMAN_GATE. No `reset --hard`, no `clean`, no `--force` anywhere.
- **State & crash recovery**: orchestrator remains the sole state owner; the
  worker holds no pipeline state. Worker loss during a run →
  `RUNNING TASK → WORKER OFFLINE → HUMAN_GATE`; nothing is auto-restarted;
  resume pulls and re-derives the safe point via the existing rescan rules.
- **Heartbeat**: every 10 s (server-assigned), offline after 30 s
  (configurable `remote.heartbeatTimeoutMs`), carrying currentAgent/taskId.
- **Network boundary**: default bind `0.0.0.0:4317` (configurable);
  non-private source addresses rejected regardless of token unless
  explicitly allowed; firewall commands for Windows/Linux/macOS and LAN-IP
  discovery documented in README; no outbound cloud connections.
- **Data over LAN** (documented in README): worker/session ids, heartbeat
  status, dispatch metadata, rendered prompts, exit metadata, and the two
  protocol report files (capped at 256 KiB). No source code, transcripts,
  API keys, environment variables, or memory contents.
- **Observability**: `workers` + extended `status` (backed by
  `.pipeline/workers.json`); `.pipeline/pipeline.log` lines tagged
  `[orchestrator]` / `[worker]` / per-agent; agent stdout/stderr captured on
  the machine that ran the agent under `.pipeline/logs/`.

## Verification

- **Tests: 64/64 pass** (`node --test`), including the 43 pre-existing
  local-mode tests (regression) and new coverage for: valid/invalid token,
  malformed messages, registration, heartbeat, stale sessions, disconnect
  detection, reconnect (orchestrator restart → worker re-registers on its
  own), duplicate dispatch, coder/tester result propagation, git-conflict
  gating, worker crash mid-task → gate, orchestrator restart preserving the
  gate, gate never auto-resumed with a healthy worker online, and no-worker
  dispatch refusal.
- **Real two-process integration**: the distributed tests spawn the actual
  `asterim-pipeline worker` CLI as a separate OS process talking to the
  in-test orchestrator over `127.0.0.1`, with a real bare git origin and two
  clones — code moved only through git, results only through the protocol.
- **Manual CLI smoke**: `orchestrator` + `worker` both launched via the real
  CLI in separate processes; full cycle (dispatch → laptop coder commit+push
  → PC pull → tester PASS → Antigravity → phase-complete HUMAN_GATE)
  confirmed, including `workers`/`status` output and clean `stop`.
- **ESLint: clean. Typecheck (tsc checkJs strict): clean.** No build step
  exists (plain Node ESM); the CLI runs directly.
- Independent review of the full git diff against every acceptance criterion
  was performed; one hardening issue found and fixed during review (a poll
  held by a stale session could receive a command destined for the new
  session; now released on re-register).

## Known limitations (by design, kept small)

- One worker at a time; the pipeline is sequential so more would add
  complexity without throughput.
- LAN traffic is plain HTTP; the payload is deliberately non-sensitive and
  the port must not be exposed beyond the LAN (documented; SSH tunnel
  suggested for untrusted networks).
- If the orchestrator process itself dies mid-dispatch, restart lands in
  HUMAN_GATE (existing rule: a task that was in flight is never blindly
  restarted).
