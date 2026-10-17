'use strict';

// Shared test rig: a real Branch Console server against a throwaway repo ("app") next to a local
// bare "origin". Never touches scalper. The `wt` script can be replaced by a small stub that logs
// what it was asked and does the matching git work.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

const WT_STUB = `#!/bin/bash
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(dirname "$REPO")"
echo "$*" >> "$PARENT/wt.log"
cmd="$1"; n="$2"; branch="$3"
dir="$PARENT/$(basename "$REPO")-$((3000 + n))"
case "$cmd" in
  create)
    [ -e "$PARENT/wt.fail" ] && { echo "boom" >&2; exit 1; }
    git -C "$REPO" worktree add "$dir" "$branch" ;;
  remove)
    [ -e "$PARENT/wt.noop" ] && exit 0
    git -C "$REPO" worktree remove --force "$dir" ;;
  delete)
    read -r ans
    echo "stdin=$ans" >> "$PARENT/wt.log"
    [ "$ans" = y ] || exit 0
    git -C "$REPO" worktree remove --force "$dir" ;;
esac
`;

// Commit a new file in `dir` as someone else (name, email), like a teammate's work.
function commitAs(dir, name, email, message) {
  fs.writeFileSync(path.join(dir, `${message.replace(/\W+/g, '-')}.txt`), message + '\n');
  execFileSync('git', ['add', '.'], { cwd: dir, env: GIT_ENV });
  execFileSync('git', ['commit', '-m', message], {
    cwd: dir, stdio: 'ignore',
    env: { ...GIT_ENV, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
}

// A repo called "app" next to a bare origin, with one commit on main pushed.
async function withRig({ wt = false, linked = false, env = {} } = {}, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wt-')));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'app');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'main', repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'first');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  if (wt) {
    fs.mkdirSync(path.join(repo, 'scripts'));
    fs.writeFileSync(path.join(repo, 'scripts', 'wt'), WT_STUB, { mode: 0o755 });
  }

  let serving = repo;                  // `linked`: the console runs on a linked worktree, as the README allows
  if (linked) { serving = path.join(root, 'side'); git(repo, 'worktree', 'add', '-b', 'side', serving, 'origin/main'); }

  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, REPO: serving, PORT: String(port), NO_OPEN: '1', MY_EMAILS: '', MY_WORKTREES: '', ...env }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/state')).ok) break; } catch { /* not up yet */ }
    if (i > 100) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
  const rig = {
    root, repo, origin, serving,
    sibling: (name) => path.join(root, name),
    log: () => { try { return fs.readFileSync(path.join(root, 'wt.log'), 'utf8'); } catch { return ''; } },
    get: (p) => fetch(base + p).then((r) => r.json()),
    post: (p, body) => fetch(base + '/api/' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json()),
    worktrees: async () => (await rig.get('/api/branches')).worktrees,
    branches: () => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(),
  };
  try { await fn(rig); } finally {
    child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { git, tryGit, commitAs, withRig, GIT_ENV };
