// No dependencies: runs from the action checkout as is. See action.yml.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = (name) => process.env[`INPUT_${name.toUpperCase()}`] ?? "";
const git = (root, args) =>
  execFileSync("git", ["-c", "safe.directory=*", "-C", root, ...args], { maxBuffer: 1 << 30 });

/**
 * path -> blob id of every tracked file whose working copy matches the index.
 * `root` may be a subdirectory of a repository: paths are relative to it, and
 * only files below it are covered (a crate reading a file outside rebuilds,
 * which is the safe direction).
 */
export function trackedBlobs(root) {
  const dirty = new Set(git(root, ["ls-files", "-m", "-z", "--", "."]).toString().split("\0").filter(Boolean));
  const blobs = new Map();
  for (const entry of git(root, ["ls-files", "-s", "-z", "--", "."]).toString().split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const [mode, blob] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    // Submodules have no file; an uncommitted edit is not described by the index id.
    if (mode === "160000" || dirty.has(path)) continue;
    blobs.set(path, blob);
  }
  return blobs;
}

export function save(root, manifest) {
  const lines = [];
  for (const [path, blob] of trackedBlobs(root)) {
    let stat;
    try {
      stat = lstatSync(join(root, path), { bigint: true });
    } catch {
      continue;
    }
    lines.push(`${blob} ${stat.mtimeNs} ${path}\n`);
  }
  writeFileSync(`${manifest}.tmp`, lines.join(""));
  renameSync(`${manifest}.tmp`, manifest);
  return lines.length;
}

export function restore(root, manifest) {
  if (!existsSync(manifest)) return null;
  const current = trackedBlobs(root);
  let restored = 0;
  let changed = 0;
  for (const line of readFileSync(manifest, "utf8").split("\n")) {
    if (!line) continue;
    const first = line.indexOf(" ");
    const second = line.indexOf(" ", first + 1);
    const blob = line.slice(0, first);
    const mtimeNs = BigInt(line.slice(first + 1, second));
    const path = line.slice(second + 1);
    if (current.get(path) !== blob) {
      changed++;
      continue;
    }
    const full = join(root, path);
    if (lstatSync(full).isSymbolicLink()) continue;
    // utimes takes seconds; a Date keeps milliseconds, enough to stay older
    // than the build's own dep-info files.
    const when = new Date(Number(mtimeNs / 1_000_000n));
    utimesSync(full, when, when);
    restored++;
  }
  return { restored, changed };
}

function main() {
  const root = input("repository") || process.cwd();
  const manifest = input("manifest");
  if (!manifest) throw new Error("input manifest is required");
  if (process.env.STATE_isPost === "true") {
    console.log(`source-mtimes: recorded ${save(root, manifest)} files in ${manifest}`);
    return;
  }
  appendFileSync(process.env.GITHUB_STATE, "isPost=true\n");
  const result = restore(root, manifest);
  console.log(
    result
      ? `source-mtimes: restored ${result.restored} unchanged files, ${result.changed} changed or removed since the recorded build`
      : `source-mtimes: no manifest at ${manifest}; first build on this disk`,
  );
}

if (process.env.GITHUB_ACTIONS === "true") main();
