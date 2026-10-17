'use strict';

// Pure worktree rules for Branch Console — no git, no disk (the caller passes in what it saw),
// so they can be unit-tested. server.js gathers the facts and runs the commands.

const path = require('path');

// ── `git worktree list --porcelain` → [{ path, head, branch, detached, bare, locked, prunable }] ──
function parseWorktreeList(out) {
  const list = [];
  let cur = null;
  for (const line of (out || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9).trim(), head: '', branch: null, detached: false, bare: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'bare') cur.bare = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
  }
  return list;
}

// ── the `wt` script's numbering: worktree N lives in <parent>/<repo>-<3000+N>, ports FE 3000+N / BE 4000+N ──
const WT_MIN = 1, WT_MAX = 50;

function wtNumber(n) {
  if (typeof n === 'number' ? !Number.isInteger(n) : !(typeof n === 'string' && /^[1-9]\d*$/.test(n))) return null;
  const v = Number(n);
  return v >= WT_MIN && v <= WT_MAX ? v : null;
}

function wtPaths(repo, n) {
  const v = wtNumber(n);
  if (v === null) return null;
  return { n: v, path: path.join(path.dirname(repo), `${path.basename(repo)}-${3000 + v}`), fe: 3000 + v, be: 4000 + v };
}

// Which `wt` number made this folder? null for the main checkout and for hand-made worktrees.
function wtIdFor(repo, wtPath) {
  if (path.dirname(wtPath) !== path.dirname(repo)) return null;
  const prefix = `${path.basename(repo)}-`;
  const base = path.basename(wtPath);
  if (!base.startsWith(prefix)) return null;
  const m = base.slice(prefix.length).match(/^30(\d\d)$/);
  return m ? wtNumber(parseInt(m[1], 10)) : null;
}

// Smallest free number: its folder is neither a registered worktree nor present on disk.
function nextWorktreeNumber(repo, usedPaths, existsFn) {
  const used = new Set(usedPaths);
  for (let n = WT_MIN; n <= WT_MAX; n++) {
    const p = wtPaths(repo, n).path;
    if (!used.has(p) && !existsFn(p)) return n;
  }
  return null;
}

// ── names typed into the page ──
// First gate only (empty, spaces, control characters, a leading dash that git would read as an option).
// server.js then asks `git check-ref-format --branch` for the full rule set.
function branchNameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'enter a branch name';
  if (/[\s\x00-\x1f\x7f]/.test(name)) return 'a branch name cannot contain spaces or control characters';
  if (name.startsWith('-')) return 'a branch name cannot start with a dash';
  return null;
}

// Plain `git worktree add` folder: a sibling named <repo>-<suffix>. The suffix cannot climb out of the parent folder.
function gitWorktreePath(repo, suffix) {
  if (typeof suffix !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(suffix)) return null;
  return path.join(path.dirname(repo), `${path.basename(repo)}-${suffix}`);
}

module.exports = { parseWorktreeList, wtPaths, wtIdFor, nextWorktreeNumber, branchNameProblem, gitWorktreePath, WT_MIN, WT_MAX };
