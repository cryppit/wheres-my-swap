#!/usr/bin/env bash
# Checks that the live site serves exactly the public pages this checkout builds. Run `pnpm build` first; then
#   scripts/verify-live.sh            compare with the site named in src/site.ts
#   scripts/verify-live.sh <site>     compare with another copy of it
# Each file listed in dist/build-hashes.txt is fetched from the site and its SHA-256 compared with the local build.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
site="${1:-$(sed -n 's/^export const SITE = "\(.*\)";$/\1/p' "$here/src/site.ts")}"
list="$here/dist/build-hashes.txt"
[ -f "$list" ] || { echo "no dist/build-hashes.txt: run pnpm build first" >&2; exit 2; }
differ=0
while read -r want file; do
  got="$(curl -sSL "$site/$file" | shasum -a 256 | cut -d' ' -f1)"
  if [ "$got" = "$want" ]; then echo "same     $file"; else echo "DIFFERS  $file"; differ=1; fi
done < "$list"
if [ "$differ" = 0 ]; then echo "$site serves exactly this build ($(wc -l < "$list" | tr -d ' ') files)."; else echo "$site does not serve this build: check out the release it names, or wait for a deploy." >&2; fi
exit "$differ"
