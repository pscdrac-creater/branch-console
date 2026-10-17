'use strict';

// End-to-end tests for the worktree buttons against the shared throwaway-repo rig (test-support/rig.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { git, tryGit, withRig } = require('../test-support/rig');

// ── listing ───────────────────────────────────────────────────────────────────
test('the branch list includes the main checkout as a worktree and reports plain-git mode', () =>
  withRig({}, async (rig) => {
    const d = await rig.get('/api/branches');
    assert.equal(d.wtSetup.kind, 'git');
    assert.equal(d.worktrees.length, 1);
    assert.equal(d.worktrees[0].isRepo, true);
    assert.equal(d.worktrees[0].branch, 'main');
    assert.equal(d.worktrees[0].path, rig.repo);
    assert.equal(d.worktrees[0].dirtyCount, 0);
  }));

// ── create a worktree (plain git) ─────────────────────────────────────────────
test('create worktree with a new branch starts from the chosen base and does not track it', () =>
  withRig({}, async (rig) => {
    fs.writeFileSync(path.join(rig.repo, 'b.txt'), 'two\n');
    git(rig.repo, 'add', '.'); git(rig.repo, 'commit', '-m', 'local only');   // local main is now ahead of origin/main
    const r = await rig.post('worktree-add', { folder: 'login', branch: 'feat-login', newBranch: true, base: 'origin/main' });
    assert.equal(r.ok, true, r.error);
    const dir = rig.sibling('app-login');
    assert.ok(fs.existsSync(path.join(dir, 'a.txt')));
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-login');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(rig.repo, 'rev-parse', 'origin/main'));
    assert.equal(tryGit(dir, 'config', 'branch.feat-login.remote'), null, 'must not track origin/main');
    const wts = await rig.worktrees();
    assert.deepEqual(wts.map((w) => w.branch).sort(), ['feat-login', 'main']);
  }));

test('create worktree for an existing branch checks that branch out', () =>
  withRig({}, async (rig) => {
    git(rig.repo, 'branch', 'hotfix', 'origin/main');
    const r = await rig.post('worktree-add', { folder: 'hf', branch: 'hotfix', newBranch: false });
    assert.equal(r.ok, true, r.error);
    assert.equal(git(rig.sibling('app-hf'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'hotfix');
  }));

test('create worktree refuses bad input and leaves nothing behind', () =>
  withRig({}, async (rig) => {
    git(rig.repo, 'branch', 'taken', 'origin/main');
    fs.mkdirSync(rig.sibling('app-busy'));
    const before = rig.branches();
    const cases = [
      [{ folder: 'a', branch: '', newBranch: true, base: 'origin/main' }, /branch name/i],
      [{ folder: 'a', branch: '-evil', newBranch: true, base: 'origin/main' }, /dash/i],
      [{ folder: 'a', branch: 'two words', newBranch: true, base: 'origin/main' }, /space/i],
      [{ folder: 'a', branch: 'x..y', newBranch: true, base: 'origin/main' }, /not a valid branch name/i],
      [{ folder: 'a', branch: 'taken', newBranch: true, base: 'origin/main' }, /already exists/i],
      [{ folder: 'a', branch: 'new1', newBranch: true, base: 'origin/nope' }, /base/i],
      [{ folder: '../escape', branch: 'new2', newBranch: true, base: 'origin/main' }, /folder/i],
      [{ folder: 'busy', branch: 'new3', newBranch: true, base: 'origin/main' }, /already exists/i],
      [{ folder: 'a', branch: 'main', newBranch: false }, /already checked out/i],
      [{ folder: 'a', branch: 'ghost', newBranch: false }, /no branch named/i],
    ];
    for (const [body, want] of cases) {
      const r = await rig.post('worktree-add', body);
      assert.equal(r.ok, false, JSON.stringify(body));
      assert.match(r.error, want, JSON.stringify(body));
    }
    assert.deepEqual(rig.branches(), before, 'a refused request must not create a branch');
    assert.equal(fs.existsSync(rig.sibling('app-a')), false);
    assert.equal((await rig.worktrees()).length, 1);
  }));

// ── remove a worktree (plain git) ─────────────────────────────────────────────
test('remove worktree deletes the folder but keeps the branch', () =>
  withRig({}, async (rig) => {
    await rig.post('worktree-add', { folder: 'x', branch: 'feat-x', newBranch: true, base: 'origin/main' });
    const dir = rig.sibling('app-x');
    const r = await rig.post('worktree-remove', { path: dir });
    assert.equal(r.ok, true, r.error);
    assert.equal(fs.existsSync(dir), false);
    assert.ok(rig.branches().includes('feat-x'));
    assert.equal((await rig.worktrees()).length, 1);
  }));

test('remove worktree refuses uncommitted work unless told to discard it', () =>
  withRig({}, async (rig) => {
    await rig.post('worktree-add', { folder: 'x', branch: 'feat-x', newBranch: true, base: 'origin/main' });
    const dir = rig.sibling('app-x');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'unsaved\n');
    const refused = await rig.post('worktree-remove', { path: dir });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /uncommitted/i);
    assert.ok(fs.existsSync(path.join(dir, 'wip.txt')), 'the file must still be there');
    const forced = await rig.post('worktree-remove', { path: dir, force: true });
    assert.equal(forced.ok, true, forced.error);
    assert.equal(fs.existsSync(dir), false);
  }));

test('remove worktree clears a worktree whose folder was already deleted by hand', () =>
  withRig({}, async (rig) => {
    await rig.post('worktree-add', { folder: 'x', branch: 'feat-x', newBranch: true, base: 'origin/main' });
    const dir = rig.sibling('app-x');
    fs.rmSync(dir, { recursive: true });
    assert.equal((await rig.worktrees()).find((w) => w.branch === 'feat-x').prunable, true);
    const r = await rig.post('worktree-remove', { path: dir });
    assert.equal(r.ok, true, r.error);
    assert.equal((await rig.worktrees()).length, 1);
    assert.ok(rig.branches().includes('feat-x'));
  }));

test('remove worktree never removes the checkout the console runs on, even a linked one', () =>
  withRig({ linked: true }, async (rig) => {
    const r = await rig.post('worktree-remove', { path: rig.serving, force: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /cannot be removed/i);
    assert.ok(fs.existsSync(path.join(rig.serving, 'a.txt')));
  }));

test('remove worktree never removes the main checkout or a folder git does not list', () =>
  withRig({}, async (rig) => {
    const stray = rig.sibling('app-stray');
    fs.mkdirSync(stray);
    fs.writeFileSync(path.join(stray, 'keep.txt'), 'x');
    for (const p of [rig.repo, stray, '/tmp', '', undefined]) {
      const r = await rig.post('worktree-remove', { path: p, force: true });
      assert.equal(r.ok, false, String(p));
    }
    assert.ok(fs.existsSync(path.join(rig.repo, 'a.txt')));
    assert.ok(fs.existsSync(path.join(stray, 'keep.txt')));
  }));

// ── new branch inside an existing worktree ────────────────────────────────────
test('new branch in a worktree switches that worktree onto it, from the chosen base', () =>
  withRig({}, async (rig) => {
    await rig.post('worktree-add', { folder: 'x', branch: 'feat-x', newBranch: true, base: 'origin/main' });
    const dir = rig.sibling('app-x');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n'); git(dir, 'add', '.'); git(dir, 'commit', '-m', 'work on x');
    const r = await rig.post('branch-new', { worktree: dir, name: 'feat-y', base: 'origin/main' });
    assert.equal(r.ok, true, r.error);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-y');
    assert.equal(git(dir, 'rev-parse', 'HEAD'), git(rig.repo, 'rev-parse', 'origin/main'));
    assert.equal(tryGit(dir, 'config', 'branch.feat-y.remote'), null);
    assert.ok(rig.branches().includes('feat-x'), 'the old branch must survive');
  }));

test('new branch refuses a worktree with uncommitted files, a taken name and a bad name', () =>
  withRig({}, async (rig) => {
    await rig.post('worktree-add', { folder: 'x', branch: 'feat-x', newBranch: true, base: 'origin/main' });
    const dir = rig.sibling('app-x');
    fs.writeFileSync(path.join(dir, 'wip.txt'), 'unsaved\n');
    const dirty = await rig.post('branch-new', { worktree: dir, name: 'feat-y', base: 'origin/main' });
    assert.equal(dirty.ok, false);
    assert.match(dirty.error, /uncommitted/i);
    fs.unlinkSync(path.join(dir, 'wip.txt'));
    const taken = await rig.post('branch-new', { worktree: dir, name: 'main', base: 'origin/main' });
    assert.match(taken.error, /already exists/i);
    const bad = await rig.post('branch-new', { worktree: dir, name: 'a..b', base: 'origin/main' });
    assert.match(bad.error, /not a valid branch name/i);
    const base = await rig.post('branch-new', { worktree: dir, name: 'fine', base: 'somewhere' });
    assert.match(base.error, /base/i);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-x');
    assert.ok(!rig.branches().includes('fine'));
  }));

test('new branch will not move the main checkout off main, or use a folder git does not list', () =>
  withRig({}, async (rig) => {
    const onMain = await rig.post('branch-new', { worktree: rig.repo, name: 'feat-z', base: 'origin/main' });
    assert.equal(onMain.ok, false);
    assert.match(onMain.error, /stays on main/i);
    assert.equal(git(rig.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
    const nowhere = await rig.post('branch-new', { worktree: '/tmp', name: 'feat-z', base: 'origin/main' });
    assert.equal(nowhere.ok, false);
    assert.match(nowhere.error, /worktree/i);
  }));

// ── with the scalper `wt` script ──────────────────────────────────────────────
test('with a wt script, create hands the new branch to `wt create N`', () =>
  withRig({ wt: true }, async (rig) => {
    let d = await rig.get('/api/branches');
    assert.equal(d.wtSetup.kind, 'wt');
    assert.equal(d.wtSetup.nextNumber, 1);
    const r = await rig.post('worktree-add', { number: 1, branch: 'feat-wt', newBranch: true, base: 'origin/main' });
    assert.equal(r.ok, true, r.error);
    assert.equal(rig.log().trim(), 'create 1 feat-wt');
    assert.equal(git(rig.sibling('app-3001'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat-wt');
    assert.equal(tryGit(rig.repo, 'config', 'branch.feat-wt.remote'), null, 'must not track origin/main');
    d = await rig.get('/api/branches');
    assert.equal(d.wtSetup.nextNumber, 2);
    const made = d.worktrees.find((w) => w.branch === 'feat-wt');
    assert.equal(made.wtId, 1);
  }));

test('with a wt script, create refuses a number that is out of range or already used', () =>
  withRig({ wt: true }, async (rig) => {
    fs.mkdirSync(rig.sibling('app-3002'));
    for (const number of [0, 51, 'x', 2]) {
      const r = await rig.post('worktree-add', { number, branch: 'nb', newBranch: true, base: 'origin/main' });
      assert.equal(r.ok, false, String(number));
    }
    assert.equal(rig.log(), '', 'wt must not even be called');
    assert.ok(!rig.branches().includes('nb'));
  }));

test('with a wt script, a failed create removes the branch it made, and reports the error', () =>
  withRig({ wt: true }, async (rig) => {
    fs.writeFileSync(path.join(rig.root, 'wt.fail'), '');
    const r = await rig.post('worktree-add', { number: 1, branch: 'feat-wt', newBranch: true, base: 'origin/main' });
    assert.equal(r.ok, false);
    assert.match(r.error, /boom/);
    assert.ok(!rig.branches().includes('feat-wt'), 'the half-made branch must be cleaned up');
  }));

test('with a wt script, remove runs `wt remove N`, or `wt delete N` with a yes when the database goes too', () =>
  withRig({ wt: true }, async (rig) => {
    await rig.post('worktree-add', { number: 1, branch: 'one', newBranch: true, base: 'origin/main' });
    await rig.post('worktree-add', { number: 2, branch: 'two', newBranch: true, base: 'origin/main' });
    const keep = await rig.post('worktree-remove', { path: rig.sibling('app-3001') });
    assert.equal(keep.ok, true, keep.error);
    const drop = await rig.post('worktree-remove', { path: rig.sibling('app-3002'), dropDb: true });
    assert.equal(drop.ok, true, drop.error);
    assert.deepEqual(rig.log().trim().split('\n').slice(2), ['remove 1', 'delete 2', 'stdin=y']);
    assert.equal((await rig.worktrees()).length, 1);
  }));

test('with a wt script, remove still checks for uncommitted work first', () =>
  withRig({ wt: true }, async (rig) => {
    await rig.post('worktree-add', { number: 1, branch: 'one', newBranch: true, base: 'origin/main' });
    fs.writeFileSync(path.join(rig.sibling('app-3001'), 'wip.txt'), 'unsaved');
    const r = await rig.post('worktree-remove', { path: rig.sibling('app-3001') });
    assert.equal(r.ok, false);
    assert.match(r.error, /uncommitted/i);
    assert.equal(rig.log().trim(), 'create 1 one', 'wt remove must not run');
  }));

test('with a wt script, remove reports failure when the worktree is still there afterwards', () =>
  withRig({ wt: true }, async (rig) => {
    await rig.post('worktree-add', { number: 1, branch: 'one', newBranch: true, base: 'origin/main' });
    fs.writeFileSync(path.join(rig.root, 'wt.noop'), '');
    const r = await rig.post('worktree-remove', { path: rig.sibling('app-3001') });
    assert.equal(r.ok, false);
    assert.match(r.error, /still/i);
  }));

test('a worktree wt did not make is removed with plain git even when a wt script exists', () =>
  withRig({ wt: true }, async (rig) => {
    await rig.post('worktree-add', { number: 1, branch: 'one', newBranch: true, base: 'origin/main' });
    git(rig.repo, 'worktree', 'add', '-b', 'hand', rig.sibling('app-7001'), 'origin/main');
    const r = await rig.post('worktree-remove', { path: rig.sibling('app-7001'), dropDb: true });
    assert.equal(r.ok, true, r.error);
    assert.equal(rig.log().trim(), 'create 1 one', 'wt must not be called for a hand-made worktree');
    assert.equal(fs.existsSync(rig.sibling('app-7001')), false);
  }));
