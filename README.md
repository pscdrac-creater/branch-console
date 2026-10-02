# Branch Console

A tiny, **local-only, zero-dependency** web dashboard for the git commands you
run over and over — so you click a button instead of re-typing a prompt.

Every branch gets **one row with labelled columns**, so nothing is cut off:

| Column | What it tells you |
|--------|-------------------|
| **Branch** | Name, a plain-language **status** (see below), and the last commit |
| **vs origin/main** | Commits ahead / behind the branch you compare with |
| **Pushed** | Is it on GitHub? `in sync`, `3 not pushed`, `never pushed`, `diverged`, `remote deleted` |
| **Pull request** | PR number, state, CI checks and review — or `no PR` |
| **Running** | Which worktree it is checked out in, and its live dev ports (click to open `localhost`) |
| **Actions** | **Push · Open PR · Rebase · Reset · Delete** — the suggested one is highlighted |

**Status** is the one-line answer to "what is going on with this branch?":
`Unpushed work`, `Ready for a PR`, `PR checks failing`, `PR has conflicts`,
`Changes requested`, `Approved — ready to merge`, `Local and remote differ`,
`Merged — safe to delete`, `Nothing new — safe to delete`.

Branches are grouped: **Checked out** (open in a worktree right now) →
**Other work** → **Safe to clean up** → **Base branch**.

Also on the page:

- **Filters** — `All` / `Needs attention` / `Open PR` / `Clean-up`, a **Mine only**
  toggle, and a search box (press `/`). Your choices are remembered.
- **Compare with** — `origin/main` (default: what is on GitHub) or local `main`.
  Ahead/behind, Reset and Rebase all use it. If local `main` is stale you get a
  warning and a one-click **Update local main**.
- **Click a row** to expand it: the commits that are not in the target, files
  changed, remote branch, worktree path, dev servers, and full PR details.
- **Freshness** — auto-refreshes every 30s while the tab is visible; the header
  shows when the page last updated and when the repo last fetched. `r` refreshes.
- **Fetch** (`git fetch --prune origin`) and a `by <author>` flag on branches
  that aren't yours.

Live ports are detected from the OS, not guessed: listening processes are matched
to worktrees by their working directory (`ss -ltnp` → `/proc/<pid>/cwd`), covering
the `300X`/`400X` and `7001`/`7002` dev-stack scheme.

PR info comes from one small GitHub query for exactly your local branches. If
GitHub can't be reached, the page says so and keeps showing the last good answer
instead of pretending there are no PRs.

Every action shows the **exact command** and a confirm step first. Nothing fires
on a single click.

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
| Push               | `git push -u origin <b>` (never forced)                              |
| Reset → `<target>` | `git reset --hard <target>`     | `git branch -f <b> <target>`       |
| Rebase → `<target>`| `git rebase <target>`           | `git rebase <target> <b>` (then restores your checkout) |
| PR                 | `git push -u origin <b>` then `gh pr create --base main --head <b> --fill` (or `--title/--body`) |
| Delete             | `git branch -D <b>` (+ optional `git push origin --delete <b>`) |
| Update local main  | `git pull --ff-only origin main` | `git fetch origin main:main` (fast-forward only) |

**Mine only** filters to branches whose commits ahead of `main` were authored
by you (`MY_EMAILS` + git config email); the current branch always counts as
yours. Branches that aren't yours show a `by <author>` flag so you don't reset
or delete a teammate's work.

**Targets** are `origin/main` (remote, the default) and `main` (local), chosen
with the **Compare with** toggle. Rebase auto-aborts on conflict and leaves the
repo untouched — resolve those by hand in your terminal.

After rebasing a branch that was already pushed, it shows **Local and remote
differ**: that needs a force-push, which this page never does — run
`git push --force-with-lease` in your terminal.

## Tests

```bash
npm test        # node --test — the status / PR-lookup logic in lib/status.js
```

## Troubleshooting

- **Fetch / PR spins forever or times out** — the server can't reach your SSH agent
  (those talk to GitHub over SSH). Start it from a terminal where `ssh-add -l` lists
  your keys; if it says "agent has no identities", run `ssh-add ~/.ssh/id_ed25519`
  first. Git ops are capped at 40s and fail with a clear message rather than hanging.
- **A button does nothing / Delete fails** — you're probably on an **old server
  process**. The page shows a red "Server is running old code" banner in this case.
  Fix: `./start.sh` (it stops the old process and starts the current one).
- **A button is greyed out** — hover it; the tooltip says why (current branch,
  checked out in another worktree, nothing to push, no commits for a PR, …).
- **"Pull request info could not be loaded"** — GitHub timed out or `gh` isn't
  logged in (`gh auth status`). Press **Retry**; older PR data stays on screen.

## Safety notes

- Binds to `127.0.0.1` only — not reachable from the network.
- Uses `execFile` (no shell), and validates branch names against the live
  branch list, so names can't inject commands.
- A branch checked out in another worktree can't be reset/rebased from here
  (git refuses to move it); those buttons are disabled with a 🔒 marker.
