# asterim-pipeline

A small local pipeline runner that removes the repetitive manual work of
coordinating three existing agents on the Asterim project:

1. **Antigravity** — orchestrator / architect
2. **Claude Code** — coder
3. **Claude Code** — tester

It is deliberately boring: one Node.js process, no runtime dependencies, no
database, no message queue, no services. **The repository files are the
communication protocol** — the pipeline just watches them and launches the
right agent at the right moment. The human intervenes at phase completions,
blocked states, and unexpected failures.

```
ORCHESTRATOR → tasks/current.md → CODER → reports/current.md
            → TESTER → test/report.md → ORCHESTRATOR → next task → …
```

## Requirements

- Node.js ≥ 20
- git (optional but recommended; used for history/diff validation only)

## Quick start

```bash
cd /path/to/Asterim
node /path/to/asterim-pipeline/bin/asterim-pipeline.js init
# …or `npm link` inside asterim-pipeline once, then just `asterim-pipeline init`
```

Edit `.pipeline/config.json`, have the orchestrator (or yourself) write the
first `tasks/current.md`, then:

```bash
asterim-pipeline start
```

The runner stays in the foreground (one terminal replaces the many you were
juggling). `Ctrl+C` stops it safely. All other commands work from any other
terminal.

## CLI

| command | effect |
|---|---|
| `init` | scaffold `.pipeline/config.json` and the protocol directories |
| `start` | run the pipeline loop in the foreground |
| `run-once` | run a single task cycle (coder → tester → orchestrator), then exit |
| `status` | show current phase/task/state/agents (`--json` for machines) |
| `pause` | finish the current agent, then hold before launching the next |
| `resume` | clear a pause, or acknowledge a HUMAN_GATE after review |
| `stop` | stop the running pipeline (kills any running agent) |
| `orchestrator` | distributed mode: run the pipeline, dispatching coder/tester to a LAN worker |
| `worker` | distributed mode: run as an execution node (`--host`, `--port`, `--token`, `--id`) |
| `workers` | show registered workers and their status |

All commands accept `--root <dir>` (default: current directory, or
`ASTERIM_PIPELINE_ROOT`). See "Distributed mode" below for the
orchestrator/worker/workers commands.

Exit codes: `0` ok · `1` error · `3` run-once ended at a human gate.

## The file protocol

The pipeline extracts a few machine-readable fields from otherwise free-form
markdown. Labels are case-insensitive; `:` or `=` both work.

| file | written by | required fields |
|---|---|---|
| `tasks/current.md` | orchestrator | `Task-ID: P6-03` (or `# Task P6-03` heading). Optional: `Phase: 6`, `No-Code-Changes: true`. Phase completion: `Status: PHASE_COMPLETE` instead of a Task-ID. |
| `reports/current.md` | coder | `Task-ID:` matching the task, `Status: COMPLETE` \| `BLOCKED` \| `FAILED` |
| `test/current.md` | orchestrator | test instructions; optional `Task-ID:` (if present must match) |
| `test/report.md` | tester | `Task-ID:` matching the task, `Result: PASS` \| `FAIL` |

## States

```
IDLE → TASK_READY → CODING → CODE_REPORT_READY → TESTING
     → TEST_REPORT_READY → ORCHESTRATING → TASK_READY → …
```

- Coder reports `BLOCKED`/`FAILED` → `BLOCKED` → orchestrator decides.
- Tests fail → still `TEST_REPORT_READY` → orchestrator decides (a fix task,
  usually). Repeated consecutive failures gate instead.
- `HUMAN_GATE` — the pipeline stops and prints a banner. It **never**
  continues on its own; run `asterim-pipeline resume` after review.

Human gates fire on: phase completion, unexpected agent failure or timeout,
repeatedly failing tests, repeatedly blocked coder, missing/malformed/mismatched
reports, a coder that claims COMPLETE without any git changes, corrupt pipeline
state, and ambiguous crash recovery.

## Agent completion detection

Exit codes are not trusted on their own. After each agent exits the pipeline
validates the protocol file it was supposed to write (exists, Task-ID matches,
recognized status/result) and, for the coder, that git actually shows a new
commit or code changes (changes to `.pipeline/` and the protocol files
themselves don't count). Validation failure → human gate.

## Watching

`fs.watch` (native events, no aggressive polling) on the four protocol files,
debounced per file (`watchDebounceMs`, default 1000 ms). Content is hashed:
a rewrite with identical bytes (timestamp-only change) triggers nothing.

## Configuration — `.pipeline/config.json`

```jsonc
{
  "coderCommand": "claude",          // flat shorthand…
  "testerCommand": "claude",
  "orchestratorCommand": "agy",
  "agents": {                        // …or the full form
    "coder": {
      "command": "claude",
      "args": ["-p"],                // prompt is piped via stdin by default
      "promptVia": "stdin",          // or "arg": appended as last argument
      "timeoutMinutes": 60           // 0 disables the timeout
    }
  },
  "watchDebounceMs": 1000,
  "humanGateOnPhaseComplete": true,
  "maxConsecutiveTestFailures": 3,
  "maxConsecutiveBlocked": 2,
  "skipTestingIfNoTestSpec": true,   // no test/current.md -> straight to orchestrator
  "git": {
    "enabled": true,
    "validateCoderCommit": true,     // gate if coder claims COMPLETE with no changes
    "pullBeforeCycle": false,        // optional sync for multi-machine setups
    "pushAfterCommit": false         //   (ff-only pull; plain push; never force)
  },
  "prompts": { "coder": "…", "tester": "…", "orchestrator": "…" },
  "files": { "task": "tasks/current.md", "coderReport": "reports/current.md",
             "testSpec": "test/current.md", "testReport": "test/report.md" }
}
```

Environment overrides: `ASTERIM_PIPELINE_CODER_COMMAND`,
`ASTERIM_PIPELINE_TESTER_COMMAND`, `ASTERIM_PIPELINE_ORCHESTRATOR_COMMAND`,
`ASTERIM_PIPELINE_DEBOUNCE_MS`, `ASTERIM_PIPELINE_ROOT`.

Prompt templates may use `{taskId}` (and `{trigger}` in the orchestrator
prompt, which receives a short note such as "the required tests FAILED").

## Persistent state & recovery

Minimal state lives in `.pipeline/state.json` (written atomically). On
restart:

- stopped between agents → the protocol files are re-read and the pipeline
  resumes from what they say;
- stopped **while an agent was running** (crash, `stop`, Ctrl+C mid-task) →
  `HUMAN_GATE`. An unfinished task is never blindly restarted; resuming after
  review re-evaluates the files and may re-launch the agent for the same task;
- corrupt `state.json` → `HUMAN_GATE`.

A `runner.lock` (PID) prevents two runners on the same root; stale locks from
dead processes are cleared automatically.

## Safety

The pipeline never runs `git reset --hard`, `git clean`, or force-pushes;
never deletes source files; and never executes commands found in repository
markdown — agent commands come exclusively from `.pipeline/config.json` (and
the environment overrides above). Reports are parsed for a handful of labeled
fields, nothing more. The tester is instructed not to modify production code,
and the orchestrator not to modify implementation code.

## Logs

- `.pipeline/pipeline.log` — state transitions, launches, exits, validation
  results, gates. Lines are tagged `[orchestrator]` / `[worker]` in
  distributed mode; agent activity is tagged per role.
- `.pipeline/logs/<agent>-<timestamp>.log` — each agent's captured
  stdout/stderr (`coder-*` / `tester-*` / `orchestrator-*`), written on the
  machine where the agent actually ran.

## Distributed mode (PC + laptop over LAN)

Distributed mode splits the pipeline across two machines on the same local
network. **Git remains the repository synchronization mechanism** — the LAN
protocol transports only pipeline commands, task metadata, execution status,
and the two protocol report files. Never source code, transcripts, API keys,
or environment variables.

```
PC:      asterim-pipeline orchestrator   (authoritative state + Antigravity)
              │  HTTP over LAN (Bearer token, long-poll)
laptop:  asterim-pipeline worker         (runs Claude coder + tester)
```

### Setup

Both machines need their own **clone of the same git remote**, each with a
branch tracking the remote (`git push -u origin main`).

**PC (orchestrator):**

```bash
asterim-pipeline orchestrator
```

On first run this generates the shared worker token at
`.pipeline/orchestrator.token` (git-ignored). Copy its *value* to the laptop.

**Laptop (worker):** put the token in `.pipeline/worker.token` (git-ignored),
or `ASTERIM_PIPELINE_TOKEN`, or pass `--token`. Then:

```bash
asterim-pipeline worker --host <PC-LAN-IP> --port 4317
```

Connection settings can also live in `.pipeline/worker.json`
(`{"host": "192.168.1.10", "port": 4317, "workerId": "laptop-01"}`) —
**never put the token in worker.json**; it may be committed. The laptop's
own `.pipeline/config.json` supplies the local `claude` commands for coder
and tester; prompts come from the orchestrator with each dispatch.

To find the PC's LAN address: `ipconfig` (Windows), `ip addr` (Linux),
`ipconfig getifaddr en0` (macOS) — use the RFC1918 address (typically
`192.168.x.x` or `10.x.x.x`).

### Execution flow

1. Orchestrator commits & pushes `tasks/current.md` + `test/current.md`
   (additive, scoped to those files; `remote.autoCommitTaskFiles: false`
   requires you/Antigravity to commit them instead).
2. `RUN_CODER` is dispatched. Worker: `git pull --ff-only` → run coder →
   coder commits → worker `git push` (plain, never force).
3. `CODER_RESULT` returns metadata + the report content; the orchestrator
   pulls and validates with the exact same rules as local mode.
4. `RUN_TESTER`: worker pulls, runs only `test/current.md`, returns the
   `test/report.md` content in `TESTER_RESULT` (the tester commits nothing).
5. Antigravity (the orchestrator agent) runs locally on the PC as usual.

A non-fast-forward pull or rejected push on the worker produces
`WORKER_GIT_CONFLICT` and the pipeline enters a human gate. No destructive
git command (`reset --hard`, `clean`, `push --force`) is ever run anywhere.

### Liveness, idempotency, recovery

- Worker heartbeats every `remote.heartbeatIntervalMs` (10 s); the
  orchestrator declares it offline after `remote.heartbeatTimeoutMs` (30 s).
- Worker loss while a task runs → `RUNNING TASK → WORKER OFFLINE →
  HUMAN_GATE`. Interrupted Claude processes are **never** auto-restarted;
  after the worker reconnects, review and run `asterim-pipeline resume` —
  the pipeline pulls and re-derives the safe recovery point from the
  protocol files.
- Commands are delivered at-least-once (re-offered every
  `remote.redeliverMs` until acknowledged by a result); the worker
  deduplicates by `dispatchId`, so a duplicated `RUN_CODER` can never launch
  two coders. Results are queued on the worker and retried across
  reconnects.
- The worker keeps no pipeline state; the orchestrator's
  `.pipeline/state.json` remains the single authority, and all local-mode
  human gates and crash recovery behavior apply unchanged.

### Network boundary

- The **orchestrator** listens on `remote.bind` (default `0.0.0.0`) at
  `remote.port` (default `4317`). Bind to a specific LAN interface address
  to narrow exposure. The worker listens on nothing; it only dials out to
  the configured orchestrator.
- Requests from non-private addresses (outside loopback, RFC1918,
  link-local, fc00::/7) are rejected regardless of token, unless
  `remote.allowPublicClients` is explicitly enabled. Do not expose the port
  publicly; do not port-forward it.
- Every request requires the shared token (constant-time comparison);
  malformed protocol messages are rejected and logged.
- Firewall: allow **inbound TCP `4317` from your LAN subnet only** on the
  PC. Windows: `New-NetFirewallRule -DisplayName asterim-pipeline -Direction
  Inbound -Protocol TCP -LocalPort 4317 -RemoteAddress 192.168.1.0/24
  -Action Allow`. Linux: `ufw allow from 192.168.1.0/24 to any port 4317
  proto tcp`. macOS: allow the node binary in System Settings → Network →
  Firewall. The laptop needs no inbound rule.
- Traffic is plain HTTP on your LAN. The payload is deliberately
  non-sensitive (see below); if your LAN is untrusted, tunnel it (e.g. SSH
  port-forward `ssh -L 4317:localhost:4317 pc`) — the pipeline itself makes
  no outbound cloud connections.

### Exactly what travels over the LAN

| direction | message | contents |
|---|---|---|
| worker → PC | `WORKER_REGISTER`, `WORKER_HEARTBEAT`, `WORKER_POLL` | worker id, session id, current agent role, current task id |
| PC → worker | `RUN_CODER`, `RUN_TESTER` | dispatch id, task id, the rendered prompt text |
| PC → worker | `PAUSE`, `STOP`, `NONE` | control signals, no payload |
| worker → PC | `CODER_RESULT`, `TESTER_RESULT` | dispatch/task id, exit code, timed-out flag, committed/pushed flags, and the content of `reports/current.md` / `test/report.md` (capped at 256 KiB) |
| worker → PC | `WORKER_GIT_CONFLICT`, `ERROR` | stage (pull/push) and the git/agent error text |

Nothing else: no source code (that moves through git), no agent transcripts
(they stay in the worker's `.pipeline/logs/`), no API keys, no environment
variables, no project memory.

### Observability

```bash
asterim-pipeline workers   # Worker ID / Status / Agent / Task / Last seen
asterim-pipeline status    # includes Root: and a Worker: line in distributed mode
```

**Dashboard**: the orchestrator serves a read-only live dashboard at
`http://127.0.0.1:<port>/dashboard` (URL printed at startup) — state, task,
gate banner, worker table, and a live log tail, refreshing every 2 s. It is
served **only to the orchestrator machine itself** (loopback), needs no
token, and never contains agent transcripts. To view it from another machine,
tunnel it: `ssh -L 4317:localhost:4317 <pc>`.

**Watching Claude on the worker**: the worker streams the coder/tester
stdout/stderr live into its own terminal (and always captures it to
`.pipeline/logs/<role>-*.log` on the laptop). Transcripts never leave the
machine that ran the agent. Note that `claude -p` prints its result when it
finishes, so long silences during a run are normal.

Note: `status`/`workers` read `.pipeline/` under the **current directory** —
run them from the project root or pass `--root`; the `Root:` line shows which
directory was actually inspected.

### remote.* configuration

| key | default | meaning |
|---|---|---|
| `bind` | `0.0.0.0` | orchestrator listen address |
| `port` | `4317` | orchestrator listen port |
| `heartbeatIntervalMs` | `10000` | worker heartbeat cadence (server-assigned) |
| `heartbeatTimeoutMs` | `30000` | worker declared offline after this silence |
| `pollTimeoutMs` | `25000` | long-poll hold time |
| `redeliverMs` | `5000` | unacknowledged command re-offer interval |
| `dispatchGraceMinutes` | `5` | added to the agent timeout for the dispatch timeout |
| `allowPublicClients` | `false` | accept non-LAN client addresses (leave off) |
| `autoCommitTaskFiles` | `true` | pipeline commits+pushes the task files before dispatch |

## Development

```bash
npm install        # dev tooling only (eslint, typescript for checkJs)
npm test           # node --test — unit + integration tests with fake agents
npm run lint
npm run typecheck
```
