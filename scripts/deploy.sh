#!/usr/bin/env bash
# Builds and deploys the public site to Cloudflare Workers, then checks that the site answers with this commit.
#   scripts/deploy.sh            deploy (needs `scripts/wrangler.sh login` once)
#   scripts/deploy.sh --dry-run  build and bundle only
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
commit="$(git rev-parse --short HEAD)"
dirty=""
if ! git diff --quiet HEAD -- . ; then dirty="+local"; fi
npx vite build
if [ "${1:-}" = "--dry-run" ]; then
  exec scripts/wrangler.sh deploy --dry-run --outdir "${TMPDIR:-/tmp}/wms-worker-dry-run" --var "SOURCE_COMMIT:$commit$dirty"
fi
scripts/wrangler.sh deploy --var "SOURCE_COMMIT:$commit$dirty"
site="$(sed -n 's/^export const SITE = "\(.*\)";$/\1/p' src/site.ts)"
echo "checking $site/api/health …"
for i in 1 2 3 4 5 6; do
  if curl -fsS "$site/api/health" | grep -q "\"commit\":\"$commit$dirty\""; then echo "live: $site serves $commit$dirty"; exit 0; fi
  sleep 5
done
echo "the site at $site does not answer with $commit$dirty yet: check that src/site.ts names the deployed URL" >&2
exit 1
