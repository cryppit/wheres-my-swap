#!/usr/bin/env bash
# Runs wrangler at the one version this site is tested with. It reuses a copy npx already cached (the CLI is ~200 MB
# and the Mac's disk is nearly full), else fetches exactly this version through npx. Logins and secrets stay
# wrangler's own: `scripts/wrangler.sh login`, `scripts/wrangler.sh secret put TELEGRAM_BOT_TOKEN`.
set -euo pipefail
VERSION="4.147.0"
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
for pkg in "$HOME"/.npm/_npx/*/node_modules/wrangler/package.json; do
  [ -f "$pkg" ] || continue
  if [ "$(node -p "require('$pkg').version")" = "$VERSION" ]; then
    exec node "$(dirname "$pkg")/bin/wrangler.js" "$@"
  fi
done
exec npx --yes "wrangler@$VERSION" "$@"
