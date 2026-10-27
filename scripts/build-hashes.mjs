// Writes dist/build-hashes.txt: the SHA-256 of every page, script and style the public pages are built into, in the
// form `shasum -a 256 -c` reads. Run right after `vite build` (the public pages), before Flight Recorder's own build,
// so the list is exactly what a build of the public repo gives: anyone can rebuild it and compare, file by file, with
// what their browser loaded.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(dist)
  .map((f) => relative(dist, f))
  .filter((f) => /\.(html|js|css)$/.test(f))
  .sort();
const lines = files.map((f) => `${createHash("sha256").update(readFileSync(join(dist, f))).digest("hex")}  ${f}`);
writeFileSync(join(dist, "build-hashes.txt"), `${lines.join("\n")}\n`);
console.log(`build-hashes.txt: ${files.length} files`);
