'use strict';

// Branch Console — a tiny, zero-dependency, local-only git ops dashboard.
// Lists branches in a repo and exposes one-click Push / PR / Rebase / Reset / Delete.
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

const execFileP = promisify(execFile);

const REPO = process.env.REPO || '/home/piyush/claude/scalper';
const PORT = parseInt(process.env.PORT || '5252', 10);
const HOST = '127.0.0.1';
const MAIN = process.env.MAIN_BRANCH || 'main'; // PR base + reset/rebase target name
const VALID_TARGETS = new Set([MAIN, `origin/${MAIN}`]);
const VERSION = 5; // v5: per-branch status verdict, push state, lighter PR lookup, push / update-main actions

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
async function run(file, args, { timeout = 40000 } = {}) {
  const cmd = [file, ...args.filter((a) => a !== '-C' && a !== REPO)].join(' ');
  try {
    const { stdout, stderr } = await execFileP(file, args, {
      cwd: REPO,
      maxBuffer: 16 * 1024 * 1024,
      timeout,
      killSignal: 'SIGKILL',
      env: GIT_ENV,
    });
    return { code: 0, stdout: stdout || '', stderr: stderr || '', cmd };
  } catch (e) {
    const timedOut = e.killed || e.signal === 'SIGKILL';
    const stderr = timedOut
      ? `timed out after ${Math.round(timeout / 1000)}s — likely an SSH/network/auth stall. Is your ssh-agent loaded? Check with:  ssh-add -l`
      : (e.stderr || e.message || '');
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr, cmd };
  }
}

const git = (...args) => run('git', ['-C', REPO, ...args]);
const gh = (...args) => run('gh', args);

// ── helpers ──────────────────────────────────────────────────────────────────
async function localBranches() {
  const r = await git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function parseWorktrees(out) {
  // git worktree list --porcelain → { branchName: worktreePath }
  const map = {};
  let cur = null;
  out.split('\n').forEach((line) => {
    if (line.startsWith('worktree ')) cur = line.slice(9).trim();
    else if (line.startsWith('branch ')) {
      const ref = line.slice(7).trim().replace('refs/heads/', '');
      if (cur) map[ref] = cur;
    } else if (line === '') cur = null;
  });
  return map;
}

async function worktreeMap() {
  return parseWorktrees((await git('worktree', 'list', '--porcelain')).stdout);
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
      r.ahead = 0; r.behind = 0; r.aheadAuthors = [];
    } else {
      const ab = await git('rev-list', '--left-right', '--count', `${target}...${r.name}`);
      const [behind, ahead] = ab.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
      r.ahead = ahead || 0; r.behind = behind || 0;
      if (r.ahead > 0) {
        const au = await git('log', `${target}..${r.name}`, '--format=%ae');
        r.aheadAuthors = [...new Set(au.stdout.split('\n').map(normEmail).filter(Boolean))];
      } else r.aheadAuthors = [];
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
    // mine: current branch, OR any commit unique to this branch is mine,
    // OR (no unique commits) the tip author is mine.
    r.mine = r.isCurrent
      ? true
      : (r.aheadAuthors.length ? r.aheadAuthors.some(isMineEmail) : isMineEmail(r.authorEmail));
  }));

  rows.forEach((r) => { r.status = branchStatus(r, target); }); // the one-line verdict + suggested action
  rows.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));
  return { target, current, prError: prR.error, prAt: prR.at, branches: rows };
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
