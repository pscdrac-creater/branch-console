'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseWorktreeList, wtPaths, wtIdFor, nextWorktreeNumber, branchNameProblem, gitWorktreePath,
} = require('../lib/worktrees');

const REPO = '/home/u/claude/scalper';

// ── parseWorktreeList: `git worktree list --porcelain` → one object per worktree ──
test('parseWorktreeList reads branch, detached, locked and prunable worktrees', () => {
  const out = [
    'worktree /home/u/claude/scalper', 'HEAD aaa111', 'branch refs/heads/main', '',
    'worktree /home/u/claude/scalper-3003', 'HEAD bbb222', 'branch refs/heads/Signals', '',
    'worktree /home/u/claude/scalper-3005', 'HEAD ccc333', 'detached', '',
    'worktree /home/u/claude/scalper-3007', 'HEAD ddd444', 'branch refs/heads/feat/x', 'locked in use', '',
    'worktree /home/u/claude/scalper-3009', 'HEAD eee555', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
  ].join('\n');
  const wts = parseWorktreeList(out);
  assert.equal(wts.length, 5);
  assert.deepEqual(wts[0], { path: '/home/u/claude/scalper', head: 'aaa111', branch: 'main', detached: false, bare: false, locked: false, prunable: false });
  assert.equal(wts[1].branch, 'Signals');
  assert.equal(wts[2].branch, null);
  assert.equal(wts[2].detached, true);
  assert.equal(wts[3].branch, 'feat/x');
  assert.equal(wts[3].locked, true);
  assert.equal(wts[4].prunable, true);
});

test('parseWorktreeList marks a bare entry and ignores blank input', () => {
  assert.deepEqual(parseWorktreeList(''), []);
  const [w] = parseWorktreeList('worktree /srv/repo.git\nbare\n');
  assert.equal(w.bare, true);
  assert.equal(w.branch, null);
});

// ── wtPaths: the number the `wt` script uses → folder, ports ──
test('wtPaths maps a worktree number to its folder and ports like the wt script', () => {
  assert.deepEqual(wtPaths(REPO, 3), { n: 3, path: '/home/u/claude/scalper-3003', fe: 3003, be: 4003 });
  assert.deepEqual(wtPaths(REPO, '12'), { n: 12, path: '/home/u/claude/scalper-3012', fe: 3012, be: 4012 });
  assert.equal(wtPaths(REPO, 50).fe, 3050);
});

test('wtPaths rejects numbers the wt script would reject', () => {
  for (const bad of [0, 51, -1, 2.5, '07', '', 'x', null, undefined, '3; rm -rf /', NaN])
    assert.equal(wtPaths(REPO, bad), null, String(bad));
});

// ── wtIdFor: is this folder one the wt script made? ──
test('wtIdFor recognises folders wt created and nothing else', () => {
  assert.equal(wtIdFor(REPO, '/home/u/claude/scalper-3003'), 3);
  assert.equal(wtIdFor(REPO, '/home/u/claude/scalper-3050'), 50);
  assert.equal(wtIdFor(REPO, '/home/u/claude/scalper-3051'), null, 'out of range');
  assert.equal(wtIdFor(REPO, '/home/u/claude/scalper-3000'), null, '0 is the main stack');
  assert.equal(wtIdFor(REPO, '/home/u/claude/scalper-7001'), null, 'a hand-made worktree');
  assert.equal(wtIdFor(REPO, '/home/u/other/scalper-3003'), null, 'different parent folder');
  assert.equal(wtIdFor(REPO, '/home/u/claude/other-3003'), null, 'different repo name');
  assert.equal(wtIdFor(REPO, REPO), null);
});

// ── nextWorktreeNumber: smallest number whose folder is free ──
test('nextWorktreeNumber picks the smallest number whose folder is unused', () => {
  const used = ['/home/u/claude/scalper-3003', '/home/u/claude/scalper-3005'];
  assert.equal(nextWorktreeNumber(REPO, used, () => false), 1);
  assert.equal(nextWorktreeNumber(REPO, [...used, '/home/u/claude/scalper-3001', '/home/u/claude/scalper-3002'], () => false), 4);
});

test('nextWorktreeNumber skips folders that exist on disk even when git does not list them', () => {
  const onDisk = new Set(['/home/u/claude/scalper-3001']);
  assert.equal(nextWorktreeNumber(REPO, [], (p) => onDisk.has(p)), 2);
});

test('nextWorktreeNumber returns null when all 50 are taken', () => {
  assert.equal(nextWorktreeNumber(REPO, [], () => true), null);
});

// ── branchNameProblem: first gate before git check-ref-format ──
test('branchNameProblem accepts normal names', () => {
  for (const ok of ['feat-x', 'feat/login', 'fix_1.2', 'Signals', 'a'])
    assert.equal(branchNameProblem(ok), null, ok);
});

test('branchNameProblem rejects empty names, spaces and a leading dash', () => {
  for (const bad of ['', '   ', 'has space', '-rf', '--force', 'tab\tname', 'new\nline', null, undefined, 42])
    assert.match(branchNameProblem(bad) || '', /\w/, `should reject ${JSON.stringify(bad)}`);
});

// ── gitWorktreePath: folder for a plain `git worktree add` ──
test('gitWorktreePath builds a sibling folder named <repo>-<suffix>', () => {
  assert.equal(gitWorktreePath('/srv/work/app', 'login'), '/srv/work/app-login');
  assert.equal(gitWorktreePath('/srv/work/app', 'fix_1.2'), '/srv/work/app-fix_1.2');
});

test('gitWorktreePath rejects suffixes that could escape the parent folder', () => {
  for (const bad of ['', '../x', 'a/b', '.hidden', '-x', 'a b', '..', null, undefined])
    assert.equal(gitWorktreePath('/srv/work/app', bad), null, String(bad));
});
