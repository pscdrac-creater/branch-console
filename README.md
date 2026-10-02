# Branch Console

A tiny, **local-only, zero-dependency** web dashboard for the git commands you
run over and over — so you click a button instead of re-typing a prompt.

Lists every branch in a repo and gives each one:

- **↺ Reset** — to local `main` or `origin/main` (toggle at the top)
- **⤴ Rebase** — onto local `main` or `origin/main`
- **⬈ PR** — push the branch and open a GitHub PR via `gh`
- **🗑 Delete** — force-delete the local branch (optionally the remote too)

Plus **Fetch** (`git fetch --prune`), a **Mine only** filter, and per-branch
info: ahead/behind vs the target, last commit, merged-into-main badge, open-PR
link, a `by <author>` flag on branches that aren't yours, and a 🔒 marker for
branches checked out in another worktree.

Each checked-out branch also shows **which worktree it lives in and which dev
ports it's actually running on** — e.g. `🖥 scalper-3003  FE :3003  BE :4003`
(live ports are detected from the OS, not guessed; a worktree with nothing
running shows `idle · nothing running`). Ports are matched to worktrees by the
listening process's working directory (`ss -ltnp` → `/proc/<pid>/cwd`), covering
the `300X`/`400X` and `7001`/`7002` dev-stack scheme.

A **▾ Details** dropdown on every row expands the full picture:
- **Branch** — SHA, subject, author + email, ahead/behind, upstream, merged.
- **Worktree & ports** — worktree path and each live FE/BE port (process + pid).
- **Pull request** — PR number + state (open / draft / merged / closed), base
  branch, mergeability, **CI check rollup** (e.g. `passing · 9/9`), and review
  decision.

Every Reset / Rebase / PR / Delete click shows the **exact command** and a
confirm step first. Nothing fires on a single click.

## Run

```bash
cd /home/piyush/claude/branch-console
./start.sh          # launcher: starts the server + opens your browser
# or:  node server.js
# → http://127.0.0.1:5252  (auto-opens in your browser)
```

Also installed as a desktop app — search **"Branch Console"** in your app
launcher (`~/.local/share/applications/branch-console.desktop`).

Shell alias (optional): add to `~/.bashrc`
```bash
alias bc='/home/piyush/claude/branch-console/start.sh'
```

Override defaults with env vars:

```bash
REPO=/home/piyush/claude/scalper-3001 PORT=5300 node server.js
```

| Var           | Default                        | Meaning                              |
|---------------|--------------------------------|--------------------------------------|
| `REPO`        | `/home/piyush/claude/scalper`  | Repo the console operates on         |
| `PORT`        | `5252`                         | Port (bound to `127.0.0.1` only)     |
| `MAIN_BRANCH` | `main`                         | Base branch / reset-rebase anchor    |
| `MY_EMAILS`   | _(git config user.email)_      | Comma-list of your emails for the **Mine only** filter (e.g. across machines) |
| `NO_OPEN`     | _(unset)_                      | Set to `1` to NOT auto-open the browser on start |

## How the actions map to git

| Button             | Current branch                  | Other branch                       |
|--------------------|---------------------------------|------------------------------------|
| Reset → `<target>` | `git reset --hard <target>`     | `git branch -f <b> <target>`       |
| Rebase → `<target>`| `git rebase <target>`           | `git rebase <target> <b>` (then restores your checkout) |
| PR                 | `git push -u origin <b>` then `gh pr create --base main --head <b> --fill` (or `--title/--body`) |
| Delete             | `git branch -D <b>` (+ optional `git push origin --delete <b>`) |

**Mine only** filters to branches whose commits ahead of `main` were authored
by you (`MY_EMAILS` + git config email); the current branch always counts as
yours. Branches that aren't yours show a `by <author>` flag so you don't reset
or delete a teammate's work.

**Targets** are `main` (local) and `origin/main` (remote), chosen with the
toggle. Rebase auto-aborts on conflict and leaves the repo untouched — resolve
those by hand in your terminal.

## Troubleshooting

- **Fetch / PR spins forever or times out** — the server can't reach your SSH agent
  (those talk to GitHub over SSH). Start it from a terminal where `ssh-add -l` lists
  your keys; if it says "agent has no identities", run `ssh-add ~/.ssh/id_ed25519`
  first. Git ops are capped at 40s and fail with a clear message rather than hanging.
- **A button does nothing / Delete fails** — you're probably on an **old server
  process**. The page shows a red "Server is running old code" banner in this case.
  Fix: `./start.sh` (it stops the old process and starts the current one).
- **Delete is greyed out** — that branch is the current branch, `main`, or checked
  out in another worktree. Switch away / remove the worktree first.

## Safety notes

- Binds to `127.0.0.1` only — not reachable from the network.
- Uses `execFile` (no shell), and validates branch names against the live
  branch list, so names can't inject commands.
- A branch checked out in another worktree can't be reset/rebased from here
  (git refuses to move it); those buttons are disabled with a 🔒 marker.
