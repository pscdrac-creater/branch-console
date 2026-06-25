'use strict';

// Branch Console — a tiny, zero-dependency, local-only git ops dashboard.
// Lists branches in a repo and exposes one-click Reset / Rebase / Generate-PR.
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

const execFileP = promisify(execFile);

const REPO = process.env.REPO || '/home/piyush/claude/scalper';
const PORT = parseInt(process.env.PORT || '5252', 10);
const HOST = '127.0.0.1';
const MAIN = process.env.MAIN_BRANCH || 'main'; // PR base + reset/rebase target name
const VALID_TARGETS = new Set([MAIN, `origin/${MAIN}`]);
const VERSION = 3; // bump on route/behavior changes; surfaced in /api/state so the page can warn about a stale server

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

async function getState() {
  const [cur, dirtyR, originR] = await Promise.all([
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('status', '--porcelain'),
    git('rev-parse', '--verify', `origin/${MAIN}`),
  ]);
  return {
    repo: REPO,
    current: cur.stdout.trim(),
    dirty: dirtyR.stdout.trim().length > 0,
    main: MAIN,
    hasOriginMain: originR.code === 0,
    version: VERSION,
  };
}

async function listPRs() {
  const r = await gh(
    'pr', 'list', '--state', 'open',
    '--json', 'number,url,headRefName,isDraft,title', '--limit', '200'
  );
  if (r.code !== 0) return { map: {}, error: (r.stderr || 'gh pr list failed').split('\n')[0] };
  try {
    const map = {};
    JSON.parse(r.stdout || '[]').forEach((p) => {
      map[p.headRefName] = { number: p.number, url: p.url, isDraft: p.isDraft, title: p.title };
    });
    return { map, error: null };
  } catch {
    return { map: {}, error: 'could not parse gh output' };
  }
}

async function listBranches(target) {
  if (!VALID_TARGETS.has(target)) target = MAIN;
  await ensureMyEmails();
  const SEP = '\x1f';
  const fmt = [
    '%(refname:short)', '%(objectname:short)', '%(committerdate:relative)',
    '%(upstream:short)', '%(upstream:track)', '%(authorname)', '%(authoremail)', '%(contents:subject)',
  ].join(SEP);

  const [refsR, curR, mergedR, wt, prR] = await Promise.all([
    git('for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'),
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    git('branch', '--merged', target, '--format=%(refname:short)'),
    worktreeMap(),
    listPRs(),
  ]);

  const current = curR.stdout.trim();
  const merged = new Set(mergedR.stdout.split('\n').map((s) => s.trim()).filter(Boolean));

  const rows = refsR.stdout.split('\n').filter(Boolean).map((line) => {
    const [name, sha, rel, upstream, track, author, authorEmail, subject] = line.split(SEP);
    return {
      name, sha, rel, upstream: upstream || null, track: track || '',
      author: author || '', authorEmail: normEmail(authorEmail), subject: subject || '',
    };
  });

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
    r.pr = prR.map[r.name] || null;
    // mine: current branch, OR any commit unique to this branch is mine,
    // OR (no unique commits) the tip author is mine.
    r.mine = r.isCurrent
      ? true
      : (r.aheadAuthors.length ? r.aheadAuthors.some(isMineEmail) : isMineEmail(r.authorEmail));
  }));

  rows.sort((a, b) => (b.isCurrent ? 1 : 0) - (a.isCurrent ? 1 : 0));
  return { target, current, prError: prR.error, branches: rows };
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

  const url = (cr.stdout || '').trim().split('\n').find((l) => l.startsWith('http')) || (cr.stdout || '').trim();
  return { ok: true, url, cmd: `${push.cmd} && ${cr.cmd}`, stdout: cr.stdout };
}

async function doFetch() {
  return resultOf(await git('fetch', '--prune', 'origin'));
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
    if (req.method === 'GET' && pathname === '/api/state') return send(res, 200, await getState());
    if (req.method === 'GET' && pathname === '/api/branches')
      return send(res, 200, await listBranches(url.searchParams.get('target') || MAIN));
    if (req.method === 'POST' && pathname === '/api/fetch') return send(res, 200, await doFetch());
    if (req.method === 'POST' && pathname === '/api/reset') return send(res, 200, await doReset(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/rebase') return send(res, 200, await doRebase(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/pr') return send(res, 200, await doPR(await readBody(req)));
    if (req.method === 'POST' && pathname === '/api/delete') return send(res, 200, await doDelete(await readBody(req)));

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
