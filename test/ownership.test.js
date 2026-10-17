'use strict';

// Who owns a branch, against a real server and a throwaway repo (see test-support/rig.js).
// "app" and "app-mine" are my worktrees (MY_WORKTREES); "app-other" is somebody else's.

const test = require('node:test');
const assert = require('node:assert/strict');
const { git, commitAs, withRig } = require('../test-support/rig');

const AMRIT = ['Amrit Thapa', 'amrit@t'];
const MINE = { MY_WORKTREES: 'app,app-mine', MY_EMAILS: 'me@t' };

// main ends on a commit by Amrit, like a merge into scalper's main
const withAmritOnMain = (opts, fn) => withRig(opts, async (rig) => {
  commitAs(rig.repo, ...AMRIT, 'amrit work');
  git(rig.repo, 'push', 'origin', 'main');
  await fn(rig);
});
const owners = async (rig) => Object.fromEntries((await rig.get('/api/branches')).branches.map((b) => [b.name, b]));

test('a branch open in my worktree is mine even though its last commit is Amrit’s', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'sig', rig.sibling('app-mine'), 'origin/main');
    const { sig } = await owners(rig);
    assert.equal(sig.author, 'Amrit Thapa', 'the tip really is Amrit’s');
    assert.equal(sig.mine, true);
    assert.equal(sig.owner.kind, 'worktree');
    assert.deepEqual(sig.owner.by, []);
  }));

test('a branch I moved my worktree off is still mine', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'sig', rig.sibling('app-mine'), 'origin/main');
    git(rig.sibling('app-mine'), 'switch', '-c', 'next');
    const { sig, next } = await owners(rig);
    assert.equal(sig.worktree, null, 'sig is not open anywhere now');
    assert.equal(sig.mine, true);
    assert.equal(sig.owner.kind, 'visited');
    assert.equal(next.owner.kind, 'worktree');
  }));

test('a branch in somebody else’s worktree, with nothing of its own, has no owner and no name', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'other', rig.sibling('app-other'), 'origin/main');
    git(rig.repo, 'branch', 'lonely', 'origin/main');
    const { other, lonely } = await owners(rig);
    for (const b of [other, lonely]) {
      assert.equal(b.mine, false, b.name);
      assert.equal(b.owner.kind, 'unknown', b.name);
      assert.deepEqual(b.owner.by, [], b.name);
    }
  }));

test('a branch that was only ever open in somebody else’s worktree is not mine because of that', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'other', rig.sibling('app-other'), 'origin/main');
    git(rig.sibling('app-other'), 'switch', '-c', 'second');   // `other` is now a left-behind branch there
    const { other } = await owners(rig);
    assert.equal(other.worktree, null);
    assert.equal(other.mine, false);
    assert.equal(other.owner.kind, 'unknown');
  }));

test('a branch with only Amrit’s commits, outside my worktrees, is Amrit’s', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'theirs', rig.sibling('app-other'), 'origin/main');
    commitAs(rig.sibling('app-other'), ...AMRIT, 'amrit feature');
    const { theirs } = await owners(rig);
    assert.equal(theirs.mine, false);
    assert.equal(theirs.owner.kind, 'others');
    assert.deepEqual(theirs.owner.by, ['Amrit Thapa']);
  }));

test('my own commits make a branch mine wherever it sits', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'work', rig.sibling('app-other'), 'origin/main');
    commitAs(rig.sibling('app-other'), 'Me', 'me@t', 'my feature');
    const { work } = await owners(rig);
    assert.equal(work.mine, true);
    assert.equal(work.owner.kind, 'commits');
  }));

test('worktrees named in MY_WORKTREES are flagged as mine', () =>
  withAmritOnMain({ env: MINE }, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'a', rig.sibling('app-mine'), 'origin/main');
    git(rig.repo, 'worktree', 'add', '-b', 'b', rig.sibling('app-other'), 'origin/main');
    const flags = Object.fromEntries((await rig.worktrees()).map((w) => [w.name, w.mine]));
    assert.deepEqual(flags, { app: true, 'app-mine': true, 'app-other': false });
  }));

test('without MY_WORKTREES only the checkout the console runs on is mine', () =>
  withAmritOnMain({}, async (rig) => {
    git(rig.repo, 'worktree', 'add', '-b', 'sig', rig.sibling('app-mine'), 'origin/main');
    const flags = Object.fromEntries((await rig.worktrees()).map((w) => [w.name, w.mine]));
    assert.deepEqual(flags, { app: true, 'app-mine': false });
    assert.equal((await owners(rig)).sig.mine, false);
  }));
