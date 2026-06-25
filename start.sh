#!/usr/bin/env bash
# Branch Console launcher.
# Starts the server (which auto-opens your browser) for the scalper repo.
# If it's already running on $PORT, just opens the browser instead of starting a 2nd copy.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

export REPO="${REPO:-/home/piyush/claude/scalper}"
export PORT="${PORT:-5252}"
# Your git identities, so "Mine only" works across machines (config email is added automatically).
export MY_EMAILS="${MY_EMAILS:-piyushc3@gmail.com,drac@PIyushs-MacBook-Pro.local}"

# Always restart so the latest server.js code is running — this prevents stale-route
# bugs (e.g. an old server process that 404s on /api/delete while the page shows the button).
existing="$(lsof -ti:"${PORT}" 2>/dev/null || true)"
if [ -n "$existing" ]; then
  echo "Restarting Branch Console on :${PORT} (stopping old pid(s): ${existing})…"
  kill ${existing} 2>/dev/null || true
  sleep 0.6
fi

# Fetch / PR / remote-delete talk to GitHub over SSH. Warn (don't block) if no key is loaded —
# local actions (Reset / Rebase / local Delete) work fine without it.
if ! ssh-add -l >/dev/null 2>&1; then
  echo "⚠  No SSH keys loaded in this shell — Fetch / PR / remote-delete will fail."
  echo "   Load your key first:   ssh-add ~/.ssh/id_ed25519"
  echo "   (Reset / Rebase / local Delete still work without it.)"
fi

exec node server.js
