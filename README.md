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

All commands accept `--root <dir>` (default: current directory, or
`ASTERIM_PIPELINE_ROOT`).

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
  results, gates.
- `.pipeline/logs/<agent>-<timestamp>.log` — each agent's captured
  stdout/stderr.

## Development

```bash
npm install        # dev tooling only (eslint, typescript for checkJs)
npm test           # node --test — unit + integration tests with fake agents
npm run lint
npm run typecheck
```
