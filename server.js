'use strict';

// Branch Console — a tiny, zero-dependency, local-only git ops dashboard.
// Lists branches in a repo and exposes one-click Push / PR / Rebase / Reset / Delete,
// plus New worktree / Remove worktree / New branch in a worktree.
// No code review, no Claude in the loop — these are deterministic git/gh commands.
//
//   REPO=/path/to/repo PORT=5252 node server.js
//
// Defaults: REPO=/home/piyush/claude/scalper, PORT=5252, bound to 127.0.0.1 only.

const http = require('http');
const { execFile, exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const { pushState, branchStatus, buildPrQuery, mapPrResponse, parseGithubRemote, parseShortstat } = require('./lib/status');
const { branchesVisited, branchOwner } = require('./lib/owner');
const { parseWorktreeList, wtPaths, wtIdFor, nextWorktreeNumber, branchNameProblem, gitWorktreePath, WT_MIN, WT_MAX } = require('./lib/worktrees');

const execFileP = promisify(execFile);

const REPO = process.env.REPO || '/home/piyush/claude/scalper';
const REPO_REAL = (() => { try { return fs.realpathSync(REPO); } catch { return REPO; } })(); // git prints real paths
const PORT = parseInt(process.env.PORT || '5252', 10);
const HOST = '127.0.0.1';
const MAIN = process.env.MAIN_BRANCH || 'main'; // PR base + reset/rebase target name
const VALID_TARGETS = new Set([MAIN, `origin/${MAIN}`]);
const VERSION = 7; // v7: branch ownership from your worktrees; v6: worktree list, create / remove worktree, new branch in a worktree

// "Mine" detection — a branch is mine if its commits ahead of the target were
// authored by one of these emails. Seeded from MY_EMAILS env + git config user.email.
let MY_EMAILS = (process.env.MY_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
let myEmailsReady = false;
async function ensureMyEmails() {
  if (myEmailsReady) return;
  const cfg = (await git('config', 'user.email')).stdout.trim().toLowerCase();
  if (cfg && !MY_EMAILS.includes(cfg)) MY_EMAILS.push(cfg);
  myEmailsReady = true;
}
// "Mine" also comes from worktrees: a branch open in, or ever worked on in, one of these worktrees
// (folder names, comma-separated) is mine whoever wrote its commits. Default: just the checkout
// this console runs on.
const MY_WORKTREES = new Set((process.env.MY_WORKTREES || '').split(',').map((s) => s.trim()).filter(Boolean));
if (!MY_WORKTREES.size) MY_WORKTREES.add(path.basename(REPO_REAL));
const normEmail = (e) => (e || '').replace(/[<>]/g, '').trim().toLowerCase();
const isMineEmail = (e) => MY_EMAILS.includes(normEmail(e));

// Non-interactive env so git/ssh can NEVER hang on a prompt. BatchMode makes SSH
// fail fast (clear error) instead of waiting on a passphrase when no agent is loaded.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=10',
};

// ── command runner ─────────────────────────────────────────────────────────
// Never throws, never hangs. Uses execFile (no shell) so branch names can't inject.
// stdin is closed straight away (or fed `input`), so nothing can sit waiting for an answer.
const STALL_HINT = ' — likely an SSH/network/auth stall. Is your ssh-agent loaded? Check with:  ssh-add -l';
async function run(file, args, { timeout = 40000, input = '', name = file, hint = STALL_HINT } = {}) {
  const cmd = [name, ...args.filter((a) => a !== '-C' && a !== REPO)].join(' ');
  try {
    const p = execFileP(file, args, {
      cwd: REPO,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      killSignal: 'SIGKILL',
      env: GIT_ENV,
    });
    p.child.stdin.on('error', () => {}); // the command may exit before reading its input
    p.child.stdin.end(input);
    const { stdout, stderr } = await p;
    return { code: 0, stdout: stdout || '', stderr: stderr || '', cmd };
  } catch (e) {
    const timedOut = e.killed || e.signal === 'SIGKILL';
    const stderr = timedOut
      ? `timed out after ${Math.round(timeout / 1000)}s${hint}`
      : (e.stderr || e.message || '');
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr, cmd };
  }
}

const git = (...args) => run('git', ['-C', REPO, ...args]);
const gitIn = (dir, ...args) => run('git', ['-C', dir, ...args]);
const gh = (...args) => run('gh', args);

// ── helpers ──────────────────────────────────────────────────────────────────
async function localBranches() {
  const r = await git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// { branchName: worktreePath } for every branch checked out in some worktree
async function worktreeMap() {
  const map = {};
  for (const w of parseWorktreeList((await git('worktree', 'list', '--porcelain')).stdout))
    if (w.branch) map[w.branch] = w.path;
  return map;
}

// ── running dev-server ports per worktree ─────────────────────────────────────
// A worktree runs its own frontend + backend on an offset port scheme
// (FE 300X / BE 400X, plus the 7001/7002 pair). We only surface those dev-stack
// ports and ignore shared infra (redis 6379, postgres 5432, microservices 800X).
function classifyPort(port) {
  if ((port >= 3000 && port <= 3099) || port === 7001) return 'FE';
  if ((port >= 4000 && port <= 4099) || port === 7002 || port === 8000) return 'BE';
  return null;
}

// Best-effort "expected" ports from the worktree folder name (scalper-3003 → FE 3003,
// BE 4003; scalper-7001 → FE 7001, BE 7002). Shown as a hint when nothing is live.
function expectedPorts(basename) {
  const m = (basename || '').match(/-(\d{4})$/);
  if (!m) return null;
  const fe = parseInt(m[1], 10);
  const be = fe >= 3000 && fe <= 3099 ? 4000 + (fe - 3000) : fe + 1;
  return { fe, be };
}

const _cwdCache = {};
function pidCwd(pid) {
  if (pid in _cwdCache) return _cwdCache[pid];
  let cwd = null;
  try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { cwd = null; }
  return (_cwdCache[pid] = cwd);
}

// Parse `ss -ltnpH` → dev-stack listening ports with the owning process cwd.
async function listeningDevPorts() {
  const r = await run('ss', ['-ltnpH'], { timeout: 8000 });
  if (r.code !== 0) return []; // ss missing / unreadable → just skip port info
  const byPort = {};
  r.stdout.split('\n').forEach((line) => {
    if (!line.trim()) return;
    const local = line.trim().split(/\s+/)[3] || '';       // e.g. 0.0.0.0:3003 / *:3003 / [::]:22
    const pm = local.match(/:(\d+)$/);
    if (!pm) return;
    const port = parseInt(pm[1], 10);
    const kind = classifyPort(port);
    if (!kind) return;
    const um = line.match(/users:\(\((.*)\)\)\s*$/);
    let proc = '', pid = null;
    if (um) {
      const nm = um[1].match(/^"([^"]+)"/);
      proc = nm ? nm[1].replace(/\s*\(v.*$/, '').trim() : ''; // ss truncates comm; drop " (v.." tail
      const pidm = um[1].match(/pid=(\d+)/);
      pid = pidm ? parseInt(pidm[1], 10) : null;
    }
    if (!(port in byPort)) byPort[port] = { port, kind, proc, pid, cwd: pid ? pidCwd(pid) : null };
  });
  return Object.values(byPort);
}

// Which of those ports belong to a given worktree path (process cwd == path or under it).
function portsForPath(devPorts, wtPath) {
  if (!wtPath) return [];
  const pref = wtPath.replace(/\/+$/, '') + '/';
  return devPorts
    .filter((p) => p.cwd && (p.cwd === wtPath || p.cwd.startsWith(pref)))
    .sort((a, b) => (a.kind === b.kind ? a.port - b.port : a.kind === 'FE' ? -1 : 1));
}

// When did any worktree of this repo last fetch? (newest FETCH_HEAD mtime, ms) — null if never.
async function lastFetchedAt() {
  const common = (await git('rev-parse', '--path-format=absolute', '--git-common-dir')).stdout.trim();
  if (!common) return null;
  const files = [path.join(common, 'FETCH_HEAD')];
  try {
    for (const d of fs.readdirSync(path.join(common, 'worktrees'))) files.push(path.join(common, 'worktrees', d, 'FETCH_HEAD'));
  } catch { /* no linked worktrees */ }
  let newest = null;
  for (const f of files) {
    try { const t = fs.statSync(f).mtimeMs; if (newest === null || t > newest) newest = t; } catch { /* missing */ }
  }
  return newest;
}

async function getState() {
  const [cur, dirtyR, originR, mainR, fetchedAt] = await Promise.all([
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('status', '--porcelain'),
    git('rev-parse', '--verify', `origin/${MAIN}`),
    git('rev-list', '--left-right', '--count', `${MAIN}...origin/${MAIN}`),
    lastFetchedAt(),
  ]);
  // local main vs origin/main — a stale local main makes every "vs main" number misleading
  const [mainAhead, mainBehind] = mainR.code === 0
    ? mainR.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0) : [0, 0];
  return {
    repo: REPO,
    repoName: path.basename(REPO),
    current: cur.stdout.trim(),
    dirty: dirtyR.stdout.trim().length > 0,
    dirtyCount: dirtyR.stdout.split('\n').filter((l) => l.trim()).length,
    main: MAIN,
    hasOriginMain: originR.code === 0,
    mainAhead: mainAhead || 0,
    mainBehind: mainBehind || 0,
    fetchedAt,
    version: VERSION,
  };
}

// ── worktrees ─────────────────────────────────────────────────────────────────
// With scalper's `scripts/wt` present, create / remove go through it (ports, env files, node_modules,
// database). Without it — any other repo — they are plain `git worktree` commands.
const WT_SCRIPT = path.join(REPO_REAL, 'scripts', 'wt');
function hasWtScript() {
  try { fs.accessSync(WT_SCRIPT, fs.constants.X_OK); return true; } catch { return false; }
}
const WT_SLOW = ' — the script may still be running in the background; check the worktree before trying again';
const wtRun = (args, { timeout, input } = {}) => run(WT_SCRIPT, args, { timeout, input, name: 'scripts/wt', hint: WT_SLOW });

// Every worktree of the repo with what the page needs: branch, uncommitted files, live dev ports.
async function worktreeRows(devPorts = []) {
  const listed = parseWorktreeList((await git('worktree', 'list', '--porcelain')).stdout).filter((w) => !w.bare);
  return Promise.all(listed.map(async (w) => {
    const name = path.basename(w.path);
    const folderMissing = w.prunable || !fs.existsSync(w.path);
    const dirtyCount = folderMissing ? 0
      : (await gitIn(w.path, 'status', '--porcelain')).stdout.split('\n').filter((l) => l.trim()).length;
    return {
      path: w.path, name, branch: w.branch, detached: w.detached, head: w.head.slice(0, 7),
      isRepo: w.path === REPO_REAL,           // the checkout this console was started on
      mine: MY_WORKTREES.has(name),
      locked: w.locked, prunable: folderMissing,
      dirtyCount,
      ports: portsForPath(devPorts, w.path),
      expectedPorts: expectedPorts(name),
      wtId: hasWtScript() ? wtIdFor(REPO_REAL, w.path) : null, // the number wt knows it by
    };
  }));
}

// Which of my worktrees has each branch been open in? Read from each worktree's HEAD reflog.
async function visitedInMyWorktrees(rows) {
  const out = Object.create(null); // branch names are keys: 'constructor' must not hit Object.prototype
  const mine = rows.filter((w) => w.mine && !w.prunable);
  const reflogs = await Promise.all(mine.map((w) => gitIn(w.path, 'reflog', 'show', 'HEAD', '--format=%gs')));
  mine.forEach((w, i) => {      // in worktree order, so the folder a branch is credited to is the same every time
    for (const name of branchesVisited(reflogs[i].stdout.split('\n'))) (out[name] = out[name] || []).push(w.name);
  });
  return out;
}

function worktreeSetup(rows) {
  const kind = hasWtScript() ? 'wt' : 'git';
  return {
    kind, min: WT_MIN, max: WT_MAX,
    parent: path.dirname(REPO_REAL), repoName: path.basename(REPO_REAL),
    nextNumber: kind === 'wt' ? nextWorktreeNumber(REPO_REAL, rows.map((w) => w.path), fs.existsSync) : null,
  };
}

const fail = (error, extra = {}) => ({ ok: false, error, ...extra });

// Name rules shared by "new worktree" and "new branch": git has the last word.
async function branchNameError(name) {
  const first = branchNameProblem(name);
  if (first) return first;
  const r = await git('check-ref-format', `refs/heads/${name}`);
  return r.code === 0 ? null : `“${name}” is not a valid branch name`;
}

// Create a worktree, on a new branch (made from `base`, not tracking it) or on an existing branch.
async function doWorktreeAdd({ branch, newBranch, base, number, folder }) {
  const nameErr = await branchNameError(branch);
  if (nameErr) return fail(nameErr);

  const viaWt = hasWtScript();
  const target = viaWt ? wtPaths(REPO_REAL, number) : { path: gitWorktreePath(REPO_REAL, folder) };
  if (viaWt && !target) return fail(`the worktree number must be a whole number from ${WT_MIN} to ${WT_MAX}`);
  if (!target.path) return fail('the folder name can only use letters, numbers, dots, dashes and underscores');
  const rows = await worktreeRows();
  if (fs.existsSync(target.path) || rows.some((w) => w.path === target.path))
    return fail(`${target.path} already exists`);

  const exists = (await localBranches()).includes(branch);
  if (newBranch) {
    if (!VALID_TARGETS.has(base)) return fail(`bad base: ${base}`);
    if (exists) return fail(`a branch named “${branch}” already exists`);
  } else {
    if (!exists) return fail(`there is no branch named “${branch}”`);
    const held = (await worktreeMap())[branch];
    if (held) return fail(`“${branch}” is already checked out in ${held}`);
  }

  let r;
  if (!viaWt) {
    r = await git('worktree', 'add', ...(newBranch ? ['--no-track', '-b', branch, target.path, base] : [target.path, branch]));
  } else {
    // wt makes new branches from the main checkout's HEAD, so the branch is made first, from `base`.
    let made = null;
    if (newBranch) {
      made = await git('branch', '--no-track', branch, base);
      if (made.code !== 0) return resultOf(made);
    }
    const w = await wtRun(['create', String(target.n), branch], { timeout: 15 * 60 * 1000 });
    r = made ? { ...w, cmd: `${made.cmd} && ${w.cmd}` } : w;
    if (r.code !== 0 && made && !(await worktreeMap())[branch]) await git('branch', '-D', branch); // nothing took the branch: undo it
  }
  if (r.code !== 0) return resultOf(r);
  if (!(await worktreeRows()).some((w) => w.path === target.path))
    return { ...resultOf(r), ok: false, error: `the command finished but ${target.path} is not a worktree` };
  prCache.at = null;
  return resultOf(r);
}

// Remove a worktree. The branch stays. Uncommitted files are only discarded when `force` says so.
async function doWorktreeRemove({ path: wtPath, dropDb, force }) {
  const w = (await worktreeRows()).find((x) => x.path === wtPath);
  if (!w) return fail('that folder is not a worktree of this repo');
  if (w.isRepo) return fail('this is the main checkout the console runs in, it cannot be removed');
  if (w.locked) return fail(`${w.name} is locked, unlock it first with: git worktree unlock ${w.path}`);
  if (w.dirtyCount && !force)
    return fail(`${w.name} has ${w.dirtyCount} uncommitted ${w.dirtyCount === 1 ? 'file' : 'files'}. Commit them, or confirm that they can be thrown away`);

  let r;
  if (w.prunable) {
    r = await git('worktree', 'prune');
  } else if (w.wtId !== null) {
    r = dropDb
      ? await wtRun(['delete', String(w.wtId)], { timeout: 5 * 60 * 1000, input: 'y\n' }) // the page already asked; wt asks again
      : await wtRun(['remove', String(w.wtId)], { timeout: 5 * 60 * 1000 });
    await git('worktree', 'prune');
  } else {
    r = await git('worktree', 'remove', ...(force ? ['--force'] : []), w.path);
  }
  if (r.code !== 0) return resultOf(r);
  if ((await worktreeRows()).some((x) => x.path === w.path) || fs.existsSync(w.path))
    return { ...resultOf(r), ok: false, error: `${w.name} is still there after the command finished` };
  return resultOf(r);
}

// Start a new branch inside an existing worktree (that worktree is switched onto it).
async function doBranchNew({ worktree, name, base }) {
  const nameErr = await branchNameError(name);
  if (nameErr) return fail(nameErr);
  if (!VALID_TARGETS.has(base)) return fail(`bad base: ${base}`);
  const w = (await worktreeRows()).find((x) => x.path === worktree);
  if (!w) return fail('that folder is not a worktree of this repo');
  if (w.isRepo && w.branch === MAIN) return fail(`this checkout stays on ${MAIN}, choose another worktree`);
  if (w.prunable) return fail(`the folder of ${w.name} is missing`);
  if (w.dirtyCount) return fail(`${w.name} has ${w.dirtyCount} uncommitted ${w.dirtyCount === 1 ? 'file' : 'files'}. Commit or stash them first`);
  if ((await localBranches()).includes(name)) return fail(`a branch named “${name}” already exists`);
  const r = await gitIn(w.path, 'switch', '-c', name, '--no-track', base);
  prCache.at = null;
  return resultOf(r);
}

// ── pull requests ─────────────────────────────────────────────────────────────
// One small GraphQL query for exactly the local branches (see lib/status.js). The last good
// answer is kept, so a GitHub hiccup shows slightly old PR data instead of "no PR" everywhere.
const PR_TTL_MS = 45000;
let prCache = { map: {}, at: null, key: '' };
let ghRepo; // { owner, name } | null — resolved once from the origin remote

async function listPRs(branches, force) {
  const key = branches.join('\n');
  if (!force && prCache.at && prCache.key === key && Date.now() - prCache.at < PR_TTL_MS)
    return { map: prCache.map, error: null, at: prCache.at };
  const fail = (error) => ({ map: prCache.map, error, at: prCache.at });

  if (ghRepo === undefined) ghRepo = parseGithubRemote((await git('remote', 'get-url', 'origin')).stdout);
  if (!ghRepo) return fail('origin is not a GitHub remote — PR info is unavailable');
  if (!branches.length) return { map: {}, error: null, at: Date.now() };

  const { query, vars } = buildPrQuery(branches, ghRepo.owner, ghRepo.name);
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push('-f', `${k}=${v}`);
  const r = await gh(...args);
  if (r.code !== 0) return fail((r.stderr || 'GitHub PR lookup failed').trim().split('\n')[0]);
  try {
    const out = JSON.parse(r.stdout || '{}');
    if (!out.data) return fail((out.errors && out.errors[0] && out.errors[0].message) || 'GitHub returned no data');
    prCache = { map: mapPrResponse(out.data, branches), at: Date.now(), key };
    return { map: prCache.map, error: null, at: prCache.at };
  } catch {
    return fail('could not parse the GitHub response');
  }
}

async function listBranches(target, force) {
  if (!VALID_TARGETS.has(target)) target = MAIN;
  await ensureMyEmails();
  const SEP = '\x1f';
  const fmt = [
    '%(refname:short)', '%(objectname:short)', '%(committerdate:relative)',
    '%(upstream:short)', '%(upstream:track)', '%(authorname)', '%(authoremail)', '%(contents:subject)',
    '%(objectname)',
  ].join(SEP);

  const [refsR, curR, mergedR, wt, devPorts] = await Promise.all([
    git('for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('branch', '--merged', target, '--format=%(refname:short)'),
    worktreeMap(),
    listeningDevPorts(),
  ]);

  const worktrees = await worktreeRows(devPorts);
  const visitedIn = await visitedInMyWorktrees(worktrees);   // branch name → [my worktree folders it was open in]
  const current = curR.stdout.trim();
  const merged = new Set(mergedR.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

  const rows = refsR.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, sha, rel, upstream, track, author, authorEmail, subject, fullSha] = line.split(SEP);
    return {
      name, sha, fullSha, rel, upstream: upstream || null, track: track || '',
      author: author || '', authorEmail: normEmail(authorEmail), subject: subject || '',
    };
  });
  const prR = await listPRs(rows.map((r) => r.name).filter((n) => n !== MAIN), force);

  await Promise.all(rows.map(async (r) => {
    if (r.name === target) {
      r.ahead = 0; r.behind = 0; r.aheadAuthors = []; r.aheadNames = [];
    } else {
      const ab = await git('rev-list', '--left-right', '--count', `${target}...${r.name}`);
      const [behind, ahead] = ab.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      r.ahead = ahead || 0; r.behind = behind || 0;
      if (r.ahead > 0) {
        const au = await git('log', `${target}..${r.name}`, '--format=%ae%x1f%an');
        const people = au.stdout.split('\n').filter(Boolean).map((l) => l.split('\x1f'));
        r.aheadAuthors = [...new Set(people.map(([e]) => normEmail(e)).filter(Boolean))];
        r.aheadNames = people.map(([, n]) => n);
      } else { r.aheadAuthors = []; r.aheadNames = []; }
    }
    r.isCurrent = r.name === current;
    r.isMain = r.name === MAIN;
    r.merged = merged.has(r.name);
    const lock = wt[r.name];
    r.lockedAt = lock && lock !== REPO ? lock : null; // checked out in ANOTHER worktree
    r.worktree = lock || null;                        // full path of the worktree it's checked out in (incl. main)
    r.worktreeName = lock ? path.basename(lock) : null;
    r.ports = portsForPath(devPorts, lock);           // dev servers actually LISTENING for this worktree
    r.expectedPorts = lock ? expectedPorts(r.worktreeName) : null;
    const pr = prR.map[r.name];
    r.pr = pr ? { ...pr, atTip: pr.headRefOid === r.fullSha } : null; // atTip: nothing new since that PR
    r.push = pushState(r.upstream, r.track);          // vs its OWN remote branch
    // mine: see lib/owner.js. The last commit's author is never used (a reset branch ends on main's).
    const openWt = worktrees.find((w) => w.path === lock);
    r.owner = branchOwner({
      name: r.name, isCurrent: r.isCurrent,
      openIn: openWt ? { folder: openWt.name, mine: openWt.mine } : null,
      visitedIn: visitedIn[r.name] || [],
      ahead: r.ahead, aheadEmails: r.aheadAuthors, aheadNames: r.aheadNames, isMineEmail,
    });
    r.mine = r.owner.mine;
  }));

  rows.forEach((r) => { r.status = branchStatus(r, target); }); // the one-line verdict + suggested action
  rows.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));
  return { target, current, prError: prR.error, prAt: prR.at, branches: rows, worktrees, wtSetup: worktreeSetup(worktrees) };
}

// Lazy per-branch detail for the expanded row: the commits this branch adds on top of the target.
async function branchDetail(name, target) {
  if (!(await localBranches()).includes(name)) return { ok: false, error: `unknown branch: ${name}` };
  if (!VALID_TARGETS.has(target)) target = MAIN;
  const SEP = '\x1f', MAX = 30;
  const [logR, statR] = await Promise.all([
    git('log', `${target}..${name}`, `--format=%h${SEP}%s${SEP}%an${SEP}%cr`, '-n', String(MAX + 1)),
    git('diff', '--shortstat', `${target}...${name}`),
  ]);
  const commits = logR.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, subject, author, rel] = line.split(SEP);
    return { sha, subject, author, rel };
  });
  return { ok: true, name, target, more: commits.length > MAX, commits: commits.slice(0, MAX), stat: parseShortstat(statR.stdout) };
}

// ── actions ──────────────────────────────────────────────────────────────────
async function doReset({ branch, target }) {
  if (!(await localBranches()).includes(branch)) return { ok: false, error: `unknown branch: ${branch}` };
  if (!VALID_TARGETS.has(target)) return { ok: false, error: `bad target: ${target}` };

  const st = await getState();
  let r;
  if (branch === st.current) {
    r = await git('reset', '--hard', target);
  } else {
    const wt = await worktreeMap();
    if (wt[branch] && wt[branch] !== REPO)
      return { ok: false, error: `'${branch}' is checked out in ${wt[branch]} — can't move it from here` };
    r = await git('branch', '-f', branch, target);
  }
  return resultOf(r);
}

async function doRebase({ branch, target }) {
  if (!(await localBranches()).includes(branch)) return { ok: false, error: `unknown branch: ${branch}` };
  if (!VALID_TARGETS.has(target)) return { ok: false, error: `bad target: ${target}` };

  const st = await getState();
  const onCurrent = branch === st.current;

  if (!onCurrent) {
    const wt = await worktreeMap();
    if (wt[branch] && wt[branch] !== REPO)
      return { ok: false, error: `'${branch}' is checked out in ${wt[branch]} — rebase it from there` };
  }

  const r = await git(...(onCurrent ? ['rebase', target] : ['rebase', target, branch]));

  if (r.code !== 0) {
    // Conflict or any failure → abort so the repo is never left mid-rebase.
    await git('rebase', '--abort'); // no-op error ignored if no rebase in progress
    if (!onCurrent) await git('checkout', st.current);
    return {
      ok: false, cmd: r.cmd, stdout: r.stdout, stderr: r.stderr,
      error: 'rebase failed (likely conflicts) — aborted, repo left unchanged. Resolve manually in your terminal.',
    };
  }
  if (!onCurrent) await git('checkout', st.current); // restore original checkout
  return resultOf(r);
}

async function doPR({ branch, title, body }) {
  if (!(await localBranches()).includes(branch)) return { ok: false, error: `unknown branch: ${branch}` };
  if (branch === MAIN) return { ok: false, error: `can't open a PR for ${MAIN}` };

  // Already open?
  const ex = await gh('pr', 'list', '--head', branch, '--state', 'open', '--json', 'url,number');
  if (ex.code === 0) {
    try {
      const a = JSON.parse(ex.stdout || '[]');
      if (a.length) return { ok: true, existing: true, url: a[0].url, number: a[0].number, cmd: `gh pr list --head ${branch}` };
    } catch { /* fall through to create */ }
  }

  const push = await git('push', '-u', 'origin', branch);
  if (push.code !== 0)
    return { ok: false, cmd: push.cmd, stderr: push.stderr, error: `push failed: ${(push.stderr || '').split('\n').slice(0, 2).join(' ')}` };

  const args = ['pr', 'create', '--base', MAIN, '--head', branch];
  if (title && title.trim()) args.push('--title', title.trim(), '--body', body || '');
  else args.push('--fill');

  const cr = await gh(...args);
  if (cr.code !== 0)
    return { ok: false, cmd: `${push.cmd} && ${cr.cmd}`, stderr: cr.stderr, error: (cr.stderr || 'gh pr create failed').split('\n').slice(0, 3).join(' ') };

  prCache.at = null; // a PR now exists — look it up fresh
  const url = (cr.stdout || '').trim().split('\n').find((l) => l.startsWith('http')) || (cr.stdout || '').trim();
  return { ok: true, url, cmd: `${push.cmd} && ${cr.cmd}`, stdout: cr.stdout };
}

async function doFetch() {
  return resultOf(await git('fetch', '--prune', 'origin'));
}

// Plain push (never forced) — a diverged branch fails with git's own message.
async function doPush({ branch }) {
  if (!(await localBranches()).includes(branch)) return { ok: false, error: `unknown branch: ${branch}` };
  if (branch === MAIN) return { ok: false, error: `refusing to push ${MAIN} from here` };
  const r = await git('push', '-u', 'origin', branch);
  prCache.at = null;
  return resultOf(r);
}

// Fast-forward local main to origin/main without checking it out.
async function doUpdateMain() {
  const wt = await worktreeMap();
  if (wt[MAIN] && wt[MAIN] !== REPO)
    return { ok: false, error: `'${MAIN}' is checked out in ${wt[MAIN]} — run 'git pull --ff-only' there` };
  if (wt[MAIN]) return resultOf(await git('pull', '--ff-only', 'origin', MAIN)); // main is the current checkout
  return resultOf(await git('fetch', 'origin', `${MAIN}:${MAIN}`));              // fast-forward only; never forced
}

async function doDelete({ branch, remote }) {
  if (!(await localBranches()).includes(branch)) return { ok: false, error: `unknown branch: ${branch}` };
  if (branch === MAIN) return { ok: false, error: `refusing to delete ${MAIN}` };

  const st = await getState();
  if (branch === st.current) return { ok: false, error: `'${branch}' is checked out — switch away first` };
  const wt = await worktreeMap();
  if (wt[branch] && wt[branch] !== REPO)
    return { ok: false, error: `'${branch}' is checked out in ${wt[branch]} — remove that worktree first` };

  const local = await git('branch', '-D', branch);
  const steps = [local];
  if (remote && local.code === 0) steps.push(await git('push', 'origin', '--delete', branch));

  const ok = steps.every((s) => s.code === 0);
  return {
    ok,
    cmd: steps.map((s) => s.cmd).join(' && '),
    stdout: steps.map((s) => s.stdout).filter((x) => x && x.trim()).join('\n'),
    stderr: steps.map((s) => s.stderr).filter((x) => x && x.trim()).join('\n'),
    error: ok ? null : steps.filter((s) => s.code !== 0).map((s) => (s.stderr || 'failed').split('\n')[0]).join('; '),
  };
}

function resultOf(r) {
  return { ok: r.code === 0, cmd: r.cmd, stdout: r.stdout, stderr: r.stderr, error: r.code !== 0 ? (r.stderr || 'command failed').split('\n').slice(0, 3).join(' ') : null };
}

// ── http ──────────────────────────────────────────────────────────────────────
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  try {
    if (req.method === 'GET' && pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && pathname === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'icon.svg')));
    }
    if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, await getState());
    if (req.method === 'GET' && pathname === '/api/branches')
      return send(res, 200, await listBranches(url.searchParams.get('target') || MAIN, url.searchParams.get('force') === '1'));
    if (req.method === 'GET' && pathname === '/api/branch')
      return send(res, 200, await branchDetail(url.searchParams.get('name') || '', url.searchParams.get('target') || MAIN));
    if (req.method === 'POST' && pathname === '/api/fetch') return send(res, 200, await doFetch());
    if (req.method === 'POST' && pathname === '/api/reset') return send(res, 200, await doReset(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/rebase') return send(res, 200, await doRebase(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/pr') return send(res, 200, await doPR(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/delete') return send(res, 200, await doDelete(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/push') return send(res, 200, await doPush(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/update-main') return send(res, 200, await doUpdateMain());
    if (req.method === 'POST' && pathname === '/api/worktree-add') return send(res, 200, await doWorktreeAdd(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/worktree-remove') return send(res, 200, await doWorktreeRemove(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/branch-new') return send(res, 200, await doBranchNew(await readBody(req)));

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  } catch (e) {
    send(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Branch Console  →  ${url}`);
  console.log(`  repo: ${REPO}`);
  console.log(`  (Ctrl-C to stop)\n`);
  // Auto-open the browser unless NO_OPEN is set. Best-effort; ignore failures.
  if (!process.env.NO_OPEN) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start ""' : 'xdg-open';
    exec(`${opener} ${url}`, () => {});
  }
});
