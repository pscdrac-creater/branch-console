'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pushState, branchStatus, buildPrQuery, mapPrResponse } = require('../lib/status');

// ── pushState: how a branch compares to its OWN remote branch ────────────────
test('pushState reads git upstream tracking info', () => {
  const cases = [
    { upstream: null,       track: '',                    want: { kind: 'local',    ahead: 0,  behind: 0 } },
    { upstream: 'origin/x', track: '',                    want: { kind: 'synced',   ahead: 0,  behind: 0 } },
    { upstream: 'origin/x', track: '[ahead 66]',          want: { kind: 'unpushed', ahead: 66, behind: 0 } },
    { upstream: 'origin/x', track: '[behind 3]',          want: { kind: 'behind',   ahead: 0,  behind: 3 } },
    { upstream: 'origin/x', track: '[ahead 1, behind 2]', want: { kind: 'diverged', ahead: 1,  behind: 2 } },
    { upstream: 'origin/x', track: '[gone]',              want: { kind: 'gone',     ahead: 0,  behind: 0 } },
  ];
  for (const c of cases) assert.deepEqual(pushState(c.upstream, c.track), c.want, `${c.upstream} ${c.track}`);
});

// ── branchStatus: the one plain-language verdict per branch ──────────────────
const synced = { kind: 'synced', ahead: 0, behind: 0 };
const branch = (over) => ({
  name: 'feat', isMain: false, isCurrent: false, lockedAt: null, worktree: null,
  ahead: 3, behind: 0, push: synced, pr: null, ...over,
});
const openPr = (over) => ({
  number: 7, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null,
  checks: { pass: 4, fail: 0, pending: 0, total: 4, overall: 'passing' }, ...over,
});
const verdict = (b) => {
  const s = branchStatus(b, 'origin/main');
  return { key: s.key, group: s.group, action: s.action };
};

test('main is the base branch and offers an update only when it is behind', () => {
  assert.deepEqual(verdict(branch({ name: 'main', isMain: true, ahead: 0, behind: 0 })),
    { key: 'base', group: 'base', action: null });
  assert.deepEqual(verdict(branch({ name: 'main', isMain: true, ahead: 0, behind: 12 })),
    { key: 'main-behind', group: 'base', action: 'update-main' });
});

test('a branch whose PR merged is clean-up and suggests delete', () => {
  assert.deepEqual(verdict(branch({ pr: openPr({ state: 'MERGED', atTip: true }) })),
    { key: 'merged', group: 'cleanup', action: 'delete' });
});

test('commits added after a PR merged are new work, not "merged"', () => {
  // A reused branch name: the old PR merged, then more commits landed on the branch.
  const b = branch({ ahead: 3, push: { kind: 'local', ahead: 0, behind: 0 }, pr: openPr({ state: 'MERGED', atTip: false }) });
  assert.deepEqual(verdict(b), { key: 'unpushed', group: 'active', action: 'pr' });
});

test('a branch with no commits of its own is clean-up and suggests delete', () => {
  assert.deepEqual(verdict(branch({ ahead: 0, behind: 40 })),
    { key: 'no-commits', group: 'cleanup', action: 'delete' });
});

test('an old merged PR on a branch with nothing new reads as "nothing new", not as that PR', () => {
  // Reused branch name: PR merged long ago, branch has since been reset onto the target.
  assert.deepEqual(verdict(branch({ ahead: 0, behind: 5, pr: openPr({ state: 'MERGED', atTip: false }) })),
    { key: 'no-commits', group: 'cleanup', action: 'delete' });
});

test('a checked-out branch is never offered for deletion', () => {
  assert.deepEqual(verdict(branch({ isCurrent: true, worktree: '/r', pr: openPr({ state: 'MERGED', atTip: true }) })),
    { key: 'merged', group: 'checkedout', action: null });
  assert.deepEqual(verdict(branch({ ahead: 0, lockedAt: '/r-3003', worktree: '/r-3003' })),
    { key: 'no-commits', group: 'checkedout', action: null });
});

test('open PR verdicts follow what blocks the merge', () => {
  const failing = { pass: 2, fail: 1, pending: 0, total: 3, overall: 'failing' };
  const pending = { pass: 2, fail: 0, pending: 1, total: 3, overall: 'pending' };
  const cases = [
    { pr: openPr({ checks: failing }),                      want: { key: 'pr-failing',  group: 'active', action: 'view-pr' } },
    { pr: openPr({ mergeable: 'CONFLICTING' }),             want: { key: 'pr-conflict', group: 'active', action: 'rebase' } },
    { pr: openPr({ reviewDecision: 'CHANGES_REQUESTED' }),  want: { key: 'pr-changes',  group: 'active', action: 'view-pr' } },
    { pr: openPr({ checks: pending }),                      want: { key: 'pr-pending',  group: 'active', action: 'view-pr' } },
    { pr: openPr({ isDraft: true }),                        want: { key: 'pr-draft',    group: 'active', action: 'view-pr' } },
    { pr: openPr({ reviewDecision: 'APPROVED' }),           want: { key: 'pr-ready',    group: 'active', action: 'view-pr' } },
    { pr: openPr(),                                         want: { key: 'pr-review',   group: 'active', action: 'view-pr' } },
  ];
  for (const c of cases) assert.deepEqual(verdict(branch({ pr: c.pr })), c.want, c.want.key);
});

test('unpushed commits on an open PR come first, because pushing may fix the rest', () => {
  const failing = { pass: 0, fail: 2, pending: 0, total: 2, overall: 'failing' };
  const b = branch({ push: { kind: 'unpushed', ahead: 2, behind: 0 }, pr: openPr({ checks: failing }) });
  assert.deepEqual(verdict(b), { key: 'pr-unpushed', group: 'active', action: 'push' });
});

test('a diverged branch never suggests a plain push, even with an open PR', () => {
  // The usual state after rebasing a pushed branch: a normal push would be rejected.
  const b = branch({ push: { kind: 'diverged', ahead: 3, behind: 2 }, pr: openPr() });
  assert.deepEqual(verdict(b), { key: 'diverged', group: 'active', action: null });
});

test('a conflicting PR in another worktree cannot be rebased from here', () => {
  const b = branch({ lockedAt: '/r-3003', worktree: '/r-3003', pr: openPr({ mergeable: 'CONFLICTING' }) });
  assert.deepEqual(verdict(b), { key: 'pr-conflict', group: 'checkedout', action: null });
});

test('work without a PR is judged by whether it reached the remote', () => {
  const cases = [
    { push: { kind: 'local', ahead: 0, behind: 0 },    want: { key: 'unpushed', group: 'active', action: 'pr' } },
    { push: { kind: 'unpushed', ahead: 1, behind: 0 }, want: { key: 'unpushed', group: 'active', action: 'pr' } },
    { push: { kind: 'gone', ahead: 0, behind: 0 },     want: { key: 'unpushed', group: 'active', action: 'pr' } },
    { push: { kind: 'diverged', ahead: 1, behind: 2 }, want: { key: 'diverged', group: 'active', action: null } },
    { push: synced,                                    want: { key: 'ready-pr', group: 'active', action: 'pr' } },
  ];
  for (const c of cases) assert.deepEqual(verdict(branch({ push: c.push })), c.want, c.push.kind);
});

test('a closed, unmerged PR with commits left is flagged, not treated as merged', () => {
  assert.deepEqual(verdict(branch({ pr: openPr({ state: 'CLOSED' }) })),
    { key: 'pr-closed', group: 'active', action: 'view-pr' });
});

test('every verdict carries a label and a tone for the UI', () => {
  const s = branchStatus(branch({}), 'origin/main');
  assert.ok(s.label.length > 0);
  assert.ok(['good', 'info', 'warn', 'bad', 'done', 'idle'].includes(s.tone), s.tone);
});

// ── PR lookup: one small GraphQL query for exactly the local branches ────────
test('buildPrQuery passes branch names as variables, never inside the query text', () => {
  const { query, vars } = buildPrQuery(['feat/a', 'we"ird'], 'acme', 'repo');
  assert.deepEqual(vars, { owner: 'acme', name: 'repo', b0: 'feat/a', b1: 'we"ird' });
  assert.ok(!query.includes('feat/a'));
  assert.ok(!query.includes('we"ird'));
  assert.ok(query.includes('b0: pullRequests(headRefName: $b0'));
  assert.ok(query.includes('b1: pullRequests(headRefName: $b1'));
});

const prNode = (over) => ({
  number: 1, url: 'https://x/1', isDraft: false, title: 't', state: 'OPEN', reviewDecision: null,
  baseRefName: 'main', updatedAt: '2026-10-01T00:00:00Z', mergeable: 'MERGEABLE',
  commits: { nodes: [] }, ...over,
});

test('mapPrResponse prefers the open PR over a newer closed one', () => {
  const data = { repository: {
    b0: { nodes: [prNode({ number: 15, state: 'CLOSED' }), prNode({ number: 12, state: 'OPEN' })] },
    b1: { nodes: [] },
  } };
  const map = mapPrResponse(data, ['feat', 'other']);
  assert.equal(map.feat.number, 12);
  assert.equal(map.other, undefined);
});

test('mapPrResponse picks the newest PR when none is open', () => {
  const data = { repository: { b0: { nodes: [prNode({ number: 3, state: 'CLOSED' }), prNode({ number: 9, state: 'MERGED' })] } } };
  assert.equal(mapPrResponse(data, ['feat']).feat.number, 9);
});

test('mapPrResponse rolls CI checks up into pass / fail / pending counts', () => {
  const contexts = { nodes: [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
    { __typename: 'StatusContext', state: 'FAILURE' },
  ] };
  const data = { repository: { b0: { nodes: [prNode({
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts } } }] },
  })] } } };
  assert.deepEqual(mapPrResponse(data, ['feat']).feat.checks,
    { pass: 1, fail: 1, pending: 1, total: 3, overall: 'failing' });
});

test('mapPrResponse keeps the PR head commit, so new work after a merge can be detected', () => {
  const data = { repository: { b0: { nodes: [prNode({ headRefOid: 'abc123' })] } } };
  assert.equal(mapPrResponse(data, ['feat']).feat.headRefOid, 'abc123');
});

test('mapPrResponse reports no checks when the PR has none', () => {
  const data = { repository: { b0: { nodes: [prNode()] } } };
  assert.equal(mapPrResponse(data, ['feat']).feat.checks, null);
});

// ── small parsers ────────────────────────────────────────────────────────────
const { parseGithubRemote, parseShortstat } = require('../lib/status');

test('parseGithubRemote finds owner and repo in SSH and HTTPS remotes', () => {
  const cases = [
    { url: 'git@github.com:acme/scalper.git',       want: { owner: 'acme', name: 'scalper' } },
    { url: 'https://github.com/acme/scalper.git\n', want: { owner: 'acme', name: 'scalper' } },
    { url: 'https://github.com/acme/my.repo',       want: { owner: 'acme', name: 'my.repo' } },
    { url: 'ssh://git@github.com/acme/scalper',     want: { owner: 'acme', name: 'scalper' } },
    { url: '/srv/git/local.git',                    want: null },
    { url: '',                                      want: null },
  ];
  for (const c of cases) assert.deepEqual(parseGithubRemote(c.url), c.want, c.url);
});

test('parseShortstat reads files / insertions / deletions from git diff --shortstat', () => {
  assert.deepEqual(parseShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)\n'), { files: 3, insertions: 10, deletions: 2 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 deletion(-)'), { files: 1, insertions: 0, deletions: 1 });
  assert.deepEqual(parseShortstat(''), { files: 0, insertions: 0, deletions: 0 });
});
