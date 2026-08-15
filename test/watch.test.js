import test from 'node:test';
import assert from 'node:assert/strict';
import { FileWatcher } from '../src/watch.js';
import { makeRoot, cleanupRoot, write, sleep } from './helpers.js';

test('a burst of writes to one file settles into a single event', async () => {
  const root = makeRoot();
  /** @type {string[]} */
  const events = [];
  const w = new FileWatcher(root, ['tasks/current.md'], 200, (rel) => events.push(rel));
  try {
    w.start();
    await sleep(50);
    for (let i = 0; i < 5; i++) {
      write(root, 'tasks/current.md', `Task-ID: T-1\nrevision ${i}\n`);
      await sleep(20); // well inside the debounce window
    }
    await sleep(600);
    assert.equal(events.length, 1, `expected 1 settled event, got ${events.length}`);
    assert.equal(events[0], 'tasks/current.md');
  } finally {
    w.close();
    cleanupRoot(root);
  }
});

test('separate bursts produce separate events; unrelated files are ignored', async () => {
  const root = makeRoot();
  /** @type {string[]} */
  const events = [];
  const w = new FileWatcher(root, ['tasks/current.md', 'test/report.md'], 100, (rel) => events.push(rel));
  try {
    w.start();
    await sleep(50);
    write(root, 'tasks/current.md', 'Task-ID: T-1\n');
    write(root, 'tasks/unrelated.md', 'noise\n');
    await sleep(300);
    write(root, 'test/report.md', 'Task-ID: T-1\nResult: PASS\n');
    await sleep(300);
    assert.deepEqual(events.sort(), ['tasks/current.md', 'test/report.md']);
  } finally {
    w.close();
    cleanupRoot(root);
  }
});

test('close() cancels pending debounce timers', async () => {
  const root = makeRoot();
  let fired = 0;
  const w = new FileWatcher(root, ['tasks/current.md'], 150, () => fired++);
  try {
    w.start();
    await sleep(50);
    write(root, 'tasks/current.md', 'Task-ID: T-1\n');
    await sleep(30);
    w.close();
    await sleep(300);
    assert.equal(fired, 0);
  } finally {
    cleanupRoot(root);
  }
});
