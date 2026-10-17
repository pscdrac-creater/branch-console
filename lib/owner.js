'use strict';

// Whose branch is this? Pure decision logic, like lib/status.js: server.js gathers the facts
// (reflogs of my worktrees, who wrote the commits) and everything here turns them into the answer.
//
// The author of a branch's LAST commit is never used. A branch that was reset to main ends on
// whoever last merged into main, which says nothing about who owns the branch.

// `git reflog show HEAD --format=%gs` lines → the branch names HEAD has sat on in that worktree.
// Only "checkout: moving from A to B" lines count, and both A and B were checked out at the time.
function branchesVisited(subjects) {
  const seen = new Set();
  for (const s of subjects || []) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(s);
    if (m) { seen.add(m[1]); seen.add(m[2]); }
  }
  return seen;
}

// facts: { name, isCurrent, openIn: { folder, mine } | null, visitedIn: [my worktree folders],
//          ahead, aheadEmails, aheadNames, isMineEmail(email) }
// → { mine, kind, why, by }   kind: current | worktree | visited | commits | others | unknown
//   `by` is only filled for other people's branches: the names behind the commits that make it theirs.
function branchOwner(f) {
  if (f.isCurrent) return { mine: true, kind: 'current', why: 'it is checked out in the checkout this console runs on', by: [] };
  if (f.openIn && f.openIn.mine)
    return { mine: true, kind: 'worktree', why: `it is open in your worktree ${f.openIn.folder}`, by: [] };
  if (f.visitedIn.length)
    return { mine: true, kind: 'visited', why: `it was worked on in your worktree ${f.visitedIn[0]}`, by: [] };
  if (f.ahead > 0 && f.aheadEmails.some(f.isMineEmail))
    return { mine: true, kind: 'commits', why: 'it has commits by you', by: [] };
  if (f.ahead > 0) {
    const by = [...new Set(f.aheadNames.filter(Boolean))];
    return { mine: false, kind: 'others', why: `its commits are by ${by.join(', ') || 'someone else'}`, by };
  }
  return { mine: false, kind: 'unknown', why: 'it has no commits of its own, so there is nothing to tell who it belongs to', by: [] };
}

module.exports = { branchesVisited, branchOwner };
