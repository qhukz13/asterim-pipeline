// End-to-end: a real worker process runs a real (fake-agent) coder, its
// output crosses the LAN as AGENT_OUTPUT, and the dashboard feed serves it
// formatted — the whole path the user watches.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/runner.js';
import { OrchestratorServer } from '../src/server.js';
import { RemoteExecutor } from '../src/remote.js';
import { OutputBus } from '../src/output-bus.js';
import { createLogger } from '../src/logger.js';
import { mergeConfig } from '../src/config.js';
import { makeGitPair, write, waitFor, fakeAgent, TEST_FILES } from './helpers.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'asterim-pipeline.js');
const TOKEN = 'live-token-0123456789abcdefghij';

test('live: agent output streams from the worker to the dashboard feed', async () => {
  const { orchRoot, workerRoot, cleanup } = makeGitPair();
  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  const remoteCfg = {
    bind: '127.0.0.1', port: 0, heartbeatIntervalMs: 200, heartbeatTimeoutMs: 4000,
    pollTimeoutMs: 250, redeliverMs: 200, dispatchGraceMinutes: 1,
    allowPublicClients: false, autoCommitTaskFiles: true,
    includeFailureOutput: true, failureOutputChars: 2000,
    streamAgentOutputToOrchestrator: true, outputFlushMs: 100, outputBufferLines: 500,
  };
  // Every agent must be a fixture: a config that leaves one unset would fall
  // through to the real binary (agy/claude) on the developer's machine.
  const orch = fakeAgent(orchRoot, 'live-orch', `bump('orch');
    console.log('reviewed reports for ' + readTaskId());
    fs.writeFileSync(path.join(root, 'tasks', 'current.md'), 'Status: PHASE_COMPLETE\\nPhase: 1\\n');
    process.exit(0);`);
  const config = mergeConfig(orchRoot, {
    git: { enabled: true },
    remote: remoteCfg,
    files: { ...TEST_FILES },
    agents: { orchestrator: { command: process.execPath, args: [orch], timeoutMinutes: 1 } },
  });
  const logger = createLogger(orchRoot, { quiet: true });
  const bus = new OutputBus({ maxLines: 500 });
  const server = new OrchestratorServer({ root: orchRoot, remoteCfg: config.remote, token: TOKEN, logger, files: config.files, bus });
  const remote = new RemoteExecutor(server, { root: orchRoot, cfg: config, logger });
  const runner = new Runner({ root: orchRoot, config, logger, remote, bus });

  try {
    // A coder that emits real stream-json events while it works.
    const coder = fakeAgent(
      workerRoot,
      'streaming-coder',
      `const cp = require('child_process');
       const say = (o) => { process.stdout.write(JSON.stringify(o) + '\\n'); };
       say({ type: 'system', subtype: 'init', model: 'claude-test', tools: ['Read', 'Edit'], permissionMode: 'default' });
       say({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/thing.ts' } }] } });
       setTimeout(() => {
         const id = readTaskId();
         fs.writeFileSync(path.join(root, 'src.txt'), 'done\\n');
         fs.writeFileSync(path.join(root, 'reports', 'current.md'), 'Task-ID: ' + id + '\\nStatus: COMPLETE\\n');
         cp.execSync('git add -A', { cwd: root });
         cp.execSync('git commit -q -m impl', { cwd: root });
         say({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, num_turns: 3 });
         process.exit(0);
       }, 700);`,
    );
    const tester = fakeAgent(
      workerRoot,
      'streaming-tester',
      `process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }) + '\\n');
       fs.writeFileSync(path.join(root, 'test', 'report.md'), 'Task-ID: ' + readTaskId() + '\\nResult: PASS\\n');
       process.exit(0);`,
    );
    write(workerRoot, '.pipeline/config.json', JSON.stringify({
      files: { ...TEST_FILES },
      remote: { streamAgentOutputToOrchestrator: true, outputFlushMs: 100 },
      agents: {
        coder: { command: process.execPath, args: [coder], timeoutMinutes: 1 },
        tester: { command: process.execPath, args: [tester], timeoutMinutes: 1 },
      },
    }));

    const port = await server.listen();
    child = spawn(process.execPath, [BIN, 'worker', '--root', workerRoot, '--host', '127.0.0.1', '--port', String(port), '--token', TOKEN, '--id', 'laptop-01'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitFor(() => server.online(), 10000);

    write(orchRoot, 'tasks/current.md', 'Task-ID: T-1\nPhase: 1\n');
    write(orchRoot, 'test/current.md', 'Task-ID: T-1\nRun tests.\n');

    // The coder takes ~700ms, so the feed must fill DURING the run.
    const running = runner.start({ once: true });
    await waitFor(() => bus.since(0).lines.some((l) => l.text.includes('▸ Edit')), 15000);
    const midRun = bus.since(0).lines;
    assert.ok(midRun.some((l) => l.text.includes('session start')), 'init event should render');
    assert.ok(midRun.every((l) => !l.text.includes('"type"')), 'raw JSON must not leak into the feed');

    const info = await running;
    // The fixture orchestrator declares the phase complete, which gates.
    assert.equal(info.gated, true, info.message);
    assert.match(runner.st.gateReason ?? '', /Phase 1 has completed/);

    const all = bus.since(0).lines;
    const text = all.map((l) => `${l.role}|${l.text}`).join('\n');
    assert.match(text, /coder\|▸ Edit {2}src\/thing\.ts/);
    assert.match(text, /coder\|✓ finished/);
    assert.match(text, /tester\|▸ Bash {2}npm test/);
    assert.match(text, /— coder started for T-1 —/);
    // The orchestrator ran locally; its output shares the same feed.
    assert.ok(all.some((l) => l.role === 'orchestrator'), 'local agent output should also reach the feed');

    // And it is reachable over the dashboard endpoint with a cursor.
    const feed = await (await fetch(`http://127.0.0.1:${port}/dashboard/output?since=0`)).json();
    assert.ok(feed.lines.length > 0);
    assert.equal(feed.dropped, false);
  } finally {
    child?.kill();
    server.close();
    cleanup();
  }
});
