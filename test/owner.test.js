'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { branchesVisited, branchOwner } = require('../lib/owner');

// ── branchesVisited: which branches HEAD has sat on, from `git reflog show HEAD --format=%gs` ──
test('branchesVisited reads both sides of every checkout', () => {
  const subjects = [
    'checkout: moving from scalper-3003 to Signals',
    'checkout: moving from main to feat/login',
    'checkout: moving from feat/login to 71b0576c539df2dc18bcc6c7e69998a83f973df8',
  ];
  assert.deepEqual([...branchesVisited(subjects)].sort(),
    ['71b0576c539df2dc18bcc6c7e69998a83f973df8', 'Signals', 'feat/login', 'main', 'scalper-3003']);
});

test('branchesVisited ignores every other kind of reflog line', () => {
  const subjects = ['commit: fix a thing', 'reset: moving to HEAD', 'merge origin/main: Fast-forward', 'pull --ff-only origin main: Fast-forward', ''];
  assert.equal(branchesVisited(subjects).size, 0);
});

// ── branchOwner: whose branch is this? ──
const facts = (over) => ({
  name: 'feat', isCurrent: false, openIn: null, visitedIn: [],
  ahead: 0, aheadEmails: [], aheadNames: [], isMineEmail: (e) => e === 'me@x', ...over,
});

test('a branch open in one of my worktrees is mine, whoever made the commits on it', () => {
  const o = branchOwner(facts({ openIn: { folder: 'scalper-3003', mine: true }, ahead: 3, aheadEmails: ['amrit@x'], aheadNames: ['Amrit Thapa'] }));
  assert.equal(o.mine, true);
  assert.equal(o.kind, 'worktree');
  assert.match(o.why, /scalper-3003/);
  assert.deepEqual(o.by, []);
});

test('a branch that was open in one of my worktrees earlier is still mine', () => {
  const o = branchOwner(facts({ visitedIn: ['scalper-3007', 'scalper'], ahead: 2, aheadEmails: ['amrit@x'], aheadNames: ['Amrit Thapa'] }));
  assert.equal(o.mine, true);
  assert.equal(o.kind, 'visited');
  assert.match(o.why, /scalper-3007/);
});

test('the branch checked out in the checkout the console runs on is mine', () => {
  assert.equal(branchOwner(facts({ isCurrent: true })).mine, true);
});

test('a branch with my commits on it is mine even in somebody else’s worktree', () => {
  const o = branchOwner(facts({ openIn: { folder: 'scalper-3005', mine: false }, ahead: 2, aheadEmails: ['amrit@x', 'me@x'], aheadNames: ['Amrit Thapa', 'Me'] }));
  assert.equal(o.mine, true);
  assert.equal(o.kind, 'commits');
  assert.deepEqual(o.by, []);
});

test('a branch with only other people’s commits is theirs, and says whose', () => {
  const o = branchOwner(facts({ openIn: { folder: 'scalper-3005', mine: false }, ahead: 3, aheadEmails: ['d@x', 'a@x'], aheadNames: ['Danish', 'Amrit Thapa', 'Danish'] }));
  assert.equal(o.mine, false);
  assert.equal(o.kind, 'others');
  assert.deepEqual(o.by, ['Danish', 'Amrit Thapa']);
});

test('a branch with nothing of its own has no owner, and the last commit author is never used', () => {
  // reset to main, sitting in nobody's worktree: the tip belongs to whoever last merged into main
  const o = branchOwner(facts({ ahead: 0, aheadEmails: [], aheadNames: [] }));
  assert.equal(o.mine, false);
  assert.equal(o.kind, 'unknown');
  assert.deepEqual(o.by, []);
});
