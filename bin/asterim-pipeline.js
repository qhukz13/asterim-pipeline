#!/usr/bin/env node
// asterim-pipeline CLI: start | run-once | status | pause | resume | stop | init

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfig, defaultConfig, PIPELINE_DIR } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { Runner } from '../src/runner.js';
import { getStatus } from '../src/status.js';
import { readLiveLock, writeControl } from '../src/control.js';
import { readState, writeState } from '../src/store.js';

const USAGE = `usage: asterim-pipeline <command> [--root <dir>] [--json]

commands:
  init       scaffold .pipeline/config.json and the protocol directories
  start      run the pipeline loop in the foreground (Ctrl+C to stop)
  run-once   run a single task cycle, then exit
  status     show pipeline status (--json for machine-readable output)
  pause      finish the current agent, then hold before launching the next
  resume     clear pause, or acknowledge a HUMAN_GATE after review
  stop       stop the running pipeline (kills any running agent)
`;

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { command: '', root: process.cwd(), json: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const a = /** @type {string} */ (rest.shift());
    if (a === '--root') {
      const v = rest.shift();
      if (!v) throw new Error('--root requires a directory');
      args.root = path.resolve(v);
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--help' || a === '-h') {
      args.command = 'help';
    } else if (!args.command) {
      args.command = a;
    } else {
      throw new Error(`unexpected argument: ${a}`);
    }
  }
  if (process.env.ASTERIM_PIPELINE_ROOT && args.root === process.cwd() && !argv.includes('--root')) {
    args.root = path.resolve(process.env.ASTERIM_PIPELINE_ROOT);
  }
  return args;
}

/** @param {string} root */
function init(root) {
  const dir = path.join(root, PIPELINE_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const cfgFile = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgFile)) {
    const d = defaultConfig(root);
    const example = {
      coderCommand: d.agents.coder.command,
      testerCommand: d.agents.tester.command,
      orchestratorCommand: d.agents.orchestrator.command,
      watchDebounceMs: d.watchDebounceMs,
      humanGateOnPhaseComplete: d.humanGateOnPhaseComplete,
      maxConsecutiveTestFailures: d.maxConsecutiveTestFailures,
      skipTestingIfNoTestSpec: d.skipTestingIfNoTestSpec,
      git: d.git,
    };
    fs.writeFileSync(cfgFile, JSON.stringify(example, null, 2) + '\n', 'utf8');
    console.log(`wrote ${cfgFile}`);
  } else {
    console.log(`${cfgFile} already exists; leaving it alone`);
  }
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, 'state.json\nstate.json.tmp\npipeline.log\nlogs/\nrunner.lock\ncontrol.json\n', 'utf8');
  }
  const cfg = loadConfig(root);
  for (const rel of Object.values(cfg.files)) {
    fs.mkdirSync(path.dirname(path.resolve(root, rel)), { recursive: true });
  }
  console.log(`initialized pipeline in ${root}`);
  console.log('edit .pipeline/config.json, write your first tasks/current.md, then run: asterim-pipeline start');
}

/**
 * pause/resume/stop: if a runner is live, signal it via the control file;
 * otherwise apply what makes sense directly to state.json.
 * @param {string} root
 * @param {'pause'|'resume'|'stop'} cmd
 */
function control(root, cmd) {
  const live = readLiveLock(root);
  if (live) {
    writeControl(root, cmd);
    console.log(`${cmd} signal sent to running pipeline (pid ${live.pid})`);
    return 0;
  }
  if (cmd === 'stop') {
    console.log('pipeline is not running');
    return 0;
  }
  const { state: s, existed } = readState(root);
  if (cmd === 'pause') {
    s.paused = true;
    writeState(root, s);
    console.log('pipeline is not running; recorded paused=true for the next start');
    return 0;
  }
  // resume, offline
  s.paused = false;
  if (s.state === 'HUMAN_GATE' || s.state === 'FAILED' || s.interrupted) {
    s.state = 'IDLE';
    s.gateReason = null;
    s.interrupted = false;
    console.log('gate acknowledged; next "asterim-pipeline start" will re-evaluate the protocol files');
  } else {
    console.log(existed ? 'pause cleared' : 'nothing to resume');
  }
  writeState(root, s);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root;

  switch (args.command) {
    case 'help':
    case '': {
      console.log(USAGE);
      return args.command ? 0 : 1;
    }
    case 'init': {
      init(root);
      return 0;
    }
    case 'start':
    case 'run-once': {
      const config = loadConfig(root);
      const logger = createLogger(config.projectRoot);
      const runner = new Runner({ root: config.projectRoot, config, logger });
      const info = await runner.start({ once: args.command === 'run-once' });
      if (args.command === 'run-once') console.log(info.message);
      return info.gated ? 3 : info.ok ? 0 : 1;
    }
    case 'status': {
      const st = getStatus(root);
      console.log(args.json ? JSON.stringify(st.json, null, 2) : st.text);
      return 0;
    }
    case 'pause':
    case 'resume':
    case 'stop':
      return control(root, args.command);
    default: {
      console.error(`unknown command: ${args.command}\n\n${USAGE}`);
      return 1;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  },
);
