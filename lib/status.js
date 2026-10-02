'use strict';

// Pure decision logic for Branch Console — no git, no network, so it can be unit-tested.
// server.js gathers the raw facts; everything here turns them into what the page shows.

// ── push state: a branch vs its OWN remote branch ────────────────────────────
// `track` is git's %(upstream:track): '', '[ahead 2]', '[behind 1]', '[ahead 2, behind 1]', '[gone]'.
function pushState(upstream, track) {
  if (!upstream) return { kind: 'local', ahead: 0, behind: 0 };       // never pushed
  if (/\bgone\b/.test(track || '')) return { kind: 'gone', ahead: 0, behind: 0 }; // remote branch deleted
  const num = (re) => { const m = (track || '').match(re); return m ? parseInt(m[1], 10) : 0; };
  const ahead = num(/ahead (\d+)/), behind = num(/behind (\d+)/);
  const kind = ahead && behind ? 'diverged' : ahead ? 'unpushed' : behind ? 'behind' : 'synced';
  return { kind, ahead, behind };
}

// ── branch status: ONE plain-language verdict per branch ─────────────────────
// Returns { key, label, hint, tone, action, group }.
//   tone   → colour: good | info | warn | bad | done | idle
//   action → the button to highlight: pr | push | rebase | delete | view-pr | update-main | null
//   group  → section on the page: checkedout | active | cleanup | base
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function branchStatus(b, target) {
  const checkedOut = !!(b.isCurrent || b.worktree);
  const locked = !!b.lockedAt;                 // checked out in ANOTHER worktree → can't be moved from here
  const push = b.push || { kind: 'local', ahead: 0, behind: 0 };
  const pr = b.pr || null;

  if (b.isMain) {
    if (b.behind > 0)
      return { key: 'main-behind', label: `Behind ${target}`, hint: `${plural(b.behind, 'commit')} behind — update before you reset or rebase onto it`,
        tone: 'warn', action: 'update-main', group: 'base' };
    return { key: 'base', label: 'Base branch', hint: `up to date with ${target}`, tone: 'idle', action: null, group: 'base' };
  }

  const group = (fallback) => (checkedOut ? 'checkedout' : fallback);
  const verdict = (key, label, hint, tone, action, fallbackGroup) => ({ key, label, hint, tone, action, group: group(fallbackGroup) });
  const canDelete = !checkedOut;

  // Finished work — nothing left that isn't already in the target.
  // (A merged PR only counts if the branch still sits on that PR's last commit — a reused
  // branch name with newer commits is new work, and falls through to the checks below.)
  if (pr && pr.state === 'MERGED' && pr.atTip)
    return verdict('merged', canDelete ? 'Merged — safe to delete' : 'Merged', `PR #${pr.number} was merged`, 'done', canDelete ? 'delete' : null, 'cleanup');
  if (!b.ahead)
    return verdict('no-commits', canDelete ? 'Nothing new — safe to delete' : 'Nothing new',
      `every commit here is already in ${target}`, 'done', canDelete ? 'delete' : null, 'cleanup');

  // Local and remote have different commits (the usual state after rebasing a pushed branch).
  // A plain push would be rejected, so no button here can fix it.
  if (push.kind === 'diverged')
    return verdict('diverged', 'Local and remote differ', `${push.ahead} to push, ${push.behind} to pull — normal after a rebase; force-push from your terminal`, 'warn', null, 'active');

  if (pr && pr.state === 'OPEN') {
    const checks = pr.checks ? pr.checks.overall : null;
    if (push.kind === 'unpushed')
      return verdict('pr-unpushed', 'PR open — commits not pushed', `${plural(push.ahead, 'commit')} only on this machine`, 'warn', 'push', 'active');
    if (pr.mergeable === 'CONFLICTING')
      return verdict('pr-conflict', 'PR has conflicts', locked ? 'rebase it in its own worktree' : `rebase onto ${target} to resolve`, 'bad', locked ? null : 'rebase', 'active');
    if (checks === 'failing')
      return verdict('pr-failing', 'PR checks failing', `${pr.checks.fail} of ${pr.checks.total} checks failed`, 'bad', 'view-pr', 'active');
    if (pr.reviewDecision === 'CHANGES_REQUESTED')
      return verdict('pr-changes', 'Changes requested', 'a reviewer asked for changes', 'warn', 'view-pr', 'active');
    if (checks === 'pending')
      return verdict('pr-pending', 'PR checks running', `${pr.checks.pass} of ${pr.checks.total} checks done`, 'info', 'view-pr', 'active');
    if (pr.isDraft)
      return verdict('pr-draft', 'Draft PR', 'mark it ready when you want a review', 'info', 'view-pr', 'active');
    if (pr.reviewDecision === 'APPROVED')
      return verdict('pr-ready', 'Approved — ready to merge', 'checks pass and the PR is approved', 'good', 'view-pr', 'active');
    return verdict('pr-review', 'PR open — waiting for review', checks === 'passing' ? 'checks pass' : 'no checks reported', 'info', 'view-pr', 'active');
  }

  if (pr && pr.state === 'CLOSED')
    return verdict('pr-closed', 'PR closed without merging', `${plural(b.ahead, 'commit')} still not in ${target}`, 'warn', 'view-pr', 'active');

  // Work with no PR yet (or new commits since an older PR merged).
  if (push.kind === 'synced' || push.kind === 'behind')
    return verdict('ready-pr', 'Ready for a PR', `${plural(b.ahead, 'commit')} pushed, no PR yet`, 'info', 'pr', 'active');
  const where = push.kind === 'unpushed' ? `${plural(push.ahead, 'commit')} not pushed yet`
    : push.kind === 'gone' ? 'its remote branch was deleted' : 'never pushed';
  return verdict('unpushed', 'Unpushed work', `${where} — only on this machine`, 'warn', 'pr', 'active');
}

// ── PR lookup ────────────────────────────────────────────────────────────────
// Roll a PR's individual CI checks up into { pass, fail, pending, total, overall }.
function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pass = 0, fail = 0, pending = 0;
  for (const c of rollup) {
    const status = (c.status || '').toUpperCase();          // CheckRun status
    const concl = (c.conclusion || c.state || '').toUpperCase(); // CheckRun conclusion / StatusContext state
    if (status && status !== 'COMPLETED') { pending++; continue; }
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(concl)) pass++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl)) fail++;
    else if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(concl)) pending++;
    else pass++; // completed but unrecognised → treat as non-blocking
  }
  const total = pass + fail + pending;
  const overall = fail ? 'failing' : pending ? 'pending' : 'passing';
  return { pass, fail, pending, total, overall };
}

const PR_FIELDS = `number url isDraft title state reviewDecision baseRefName updatedAt mergeable headRefOid
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }`;

// One GraphQL query asking only for the PRs of the given branches (aliased b0, b1, …).
// Asking for "the last 200 PRs with all their checks" is what made GitHub time out.
// Branch names travel as variables, so a strange name can never change the query.
function buildPrQuery(branches, owner, name) {
  const vars = { owner, name };
  branches.forEach((b, i) => { vars[`b${i}`] = b; });
  const decl = branches.map((_, i) => `$b${i}: String!`).join(', ');
  const body = branches.map((_, i) =>
    `b${i}: pullRequests(headRefName: $b${i}, first: 5, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ${PR_FIELDS} } }`).join('\n    ');
  const query = `query($owner: String!, $name: String!${decl ? ', ' + decl : ''}) {
  repository(owner: $owner, name: $name) {
    ${body || '__typename'}
  }
}`;
  return { query, vars };
}

// GraphQL response → { branchName: pr }. Prefers the open PR; otherwise the newest one.
function mapPrResponse(data, branches) {
  const repo = (data && data.repository) || {};
  const rank = (p) => (p.state === 'OPEN' ? 2 : 1);
  const map = {};
  branches.forEach((b, i) => {
    const nodes = (repo[`b${i}`] && repo[`b${i}`].nodes) || [];
    let best = null;
    for (const p of nodes)
      if (!best || rank(p) > rank(best) || (rank(p) === rank(best) && p.number > best.number)) best = p;
    if (!best) return;
    const commit = best.commits && best.commits.nodes && best.commits.nodes[0] && best.commits.nodes[0].commit;
    const contexts = commit && commit.statusCheckRollup && commit.statusCheckRollup.contexts;
    map[b] = {
      number: best.number, url: best.url, isDraft: !!best.isDraft, title: best.title,
      state: best.state, reviewDecision: best.reviewDecision || null, baseRefName: best.baseRefName || null,
      updatedAt: best.updatedAt || null, mergeable: best.mergeable || null, headRefOid: best.headRefOid || null,
      checks: summarizeChecks(contexts && contexts.nodes),
    };
  });
  return map;
}

// ── small parsers ────────────────────────────────────────────────────────────
// `git remote get-url origin` → { owner, name } for a GitHub remote, else null.
function parseGithubRemote(url) {
  const m = (url || '').trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// `git diff --shortstat` → { files, insertions, deletions } (all 0 for an empty diff).
function parseShortstat(out) {
  const num = (re) => { const m = (out || '').match(re); return m ? parseInt(m[1], 10) : 0; };
  return { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/) };
}

module.exports = { pushState, branchStatus, summarizeChecks, buildPrQuery, mapPrResponse, parseGithubRemote, parseShortstat };
