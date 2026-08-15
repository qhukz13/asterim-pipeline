import test from 'node:test';
import assert from 'node:assert/strict';
import { changedPaths, isRepo, hasUncommittedChanges } from '../src/git.js';
import { makeRoot, cleanupRoot, write, gitRun } from './helpers.js';

/** @param {string} root */
function initRepo(root) {
  gitRun(root, ['init', '-q', '-b', 'main']);
  gitRun(root, ['config', 'user.email', 'test@example.com']);
  gitRun(root, ['config', 'user.name', 'Test']);
}

test('changedPaths reports exact paths for modified, staged, and untracked files', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    write(root, 'tests/current.md', 'original\n');
    write(root, 'src/app.js', 'x\n');
    gitRun(root, ['add', '-A']);
    gitRun(root, ['commit', '-q', '-m', 'seed']);

    // Unstaged modification: porcelain emits " M tests/current.md" — the
    // leading space must not shift the parsed path (regression: "ests/...").
    write(root, 'tests/current.md', 'changed\n');
    assert.deepEqual(changedPaths(root), ['tests/current.md']);

    // Staged change sorts first ("M  src/app.js"), modified file still exact.
    write(root, 'src/app.js', 'y\n');
    gitRun(root, ['add', 'src/app.js']);
    assert.deepEqual(changedPaths(root).sort(), ['src/app.js', 'tests/current.md']);

    // Untracked files are listed individually (-uall), not as a directory.
    write(root, 'reports/current.md', 'new\n');
    assert.ok(changedPaths(root).includes('reports/current.md'));
    assert.ok(!changedPaths(root).includes('reports/'));
  } finally {
    cleanupRoot(root);
  }
});

test('changedPaths handles renames and quoted paths, and is empty on a clean tree', () => {
  const root = makeRoot();
  try {
    initRepo(root);
    write(root, 'a.txt', 'hello\n');
    write(root, 'has space.txt', 'hi\n');
    gitRun(root, ['add', '-A']);
    gitRun(root, ['commit', '-q', '-m', 'seed']);
    assert.deepEqual(changedPaths(root), []);
    assert.equal(hasUncommittedChanges(root), false);

    gitRun(root, ['mv', 'a.txt', 'b.txt']);
    assert.deepEqual(changedPaths(root), ['b.txt']); // rename keeps the NEW path

    write(root, 'has space.txt', 'changed\n');
    assert.ok(changedPaths(root).includes('has space.txt'));
    assert.equal(hasUncommittedChanges(root), true);
  } finally {
    cleanupRoot(root);
  }
});

test('isRepo / changedPaths are safe outside a repository', () => {
  const root = makeRoot();
  try {
    assert.equal(isRepo(root), false);
    assert.deepEqual(changedPaths(root), []);
  } finally {
    cleanupRoot(root);
  }
});
