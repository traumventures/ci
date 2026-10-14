import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restore, save } from "../actions/source-mtimes/index.mjs";

const dirs: string[] = [];
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "source-mtimes-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  git("init", "-q");
  writeFileSync(join(dir, "a.rs"), "fn a() {}\n");
  writeFileSync(join(dir, "b.rs"), "fn b() {}\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git };
}
const mtime = (path: string) => statSync(path).mtimeMs;
/** What a fresh checkout does: every file dated now. */
function checkout(dir: string) {
  const now = new Date();
  for (const file of ["a.rs", "b.rs"]) utimesSync(join(dir, file), now, now);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("source-mtimes", () => {
  test("unchanged files get the recorded mtime back", () => {
    const { dir } = repo();
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(dir, "a.rs"), old, old);
    utimesSync(join(dir, "b.rs"), old, old);
    const manifest = join(dir, ".git", "manifest");
    expect(save(dir, manifest)).toBe(2);
    checkout(dir);
    expect(restore(dir, manifest)).toEqual({ restored: 2, changed: 0 });
    expect(mtime(join(dir, "a.rs"))).toBe(old.getTime());
  });

  test("a committed change keeps the checkout time", () => {
    const { dir, git } = repo();
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(dir, "a.rs"), old, old);
    const manifest = join(dir, ".git", "manifest");
    save(dir, manifest);
    appendFileSync(join(dir, "a.rs"), "// changed\n");
    git("commit", "-qam", "change");
    checkout(dir);
    expect(restore(dir, manifest)).toEqual({ restored: 1, changed: 1 });
    expect(mtime(join(dir, "a.rs"))).toBeGreaterThan(old.getTime());
  });

  test("an uncommitted edit is neither recorded nor restored", () => {
    const { dir } = repo();
    const manifest = join(dir, ".git", "manifest");
    appendFileSync(join(dir, "a.rs"), "// local\n");
    expect(save(dir, manifest)).toBe(1);
    const before = mtime(join(dir, "a.rs"));
    expect(restore(dir, manifest)?.restored).toBe(1);
    expect(mtime(join(dir, "a.rs"))).toBe(before);
  });

  test("no manifest: first build on the disk", () => {
    const { dir } = repo();
    expect(restore(dir, join(dir, "missing"))).toBeNull();
  });

  test("a subdirectory covers its own files, paths relative to it", () => {
    const { dir, git } = repo();
    const sub = join(dir, "crate");
    execFileSync("mkdir", ["-p", sub]);
    writeFileSync(join(sub, "lib.rs"), "pub fn x() {}\n");
    git("add", ".");
    git("commit", "-qm", "sub");
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(sub, "lib.rs"), old, old);
    const manifest = join(dir, ".git", "sub-manifest");
    expect(save(sub, manifest)).toBe(1);
    const now = new Date();
    utimesSync(join(sub, "lib.rs"), now, now);
    expect(restore(sub, manifest)).toEqual({ restored: 1, changed: 0 });
    expect(mtime(join(sub, "lib.rs"))).toBe(old.getTime());
  });

  test("a path with a newline survives the manifest", () => {
    const { dir, git } = repo();
    writeFileSync(join(dir, "odd\nname.rs"), "x\n");
    git("add", ".");
    git("commit", "-qm", "odd");
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(dir, "odd\nname.rs"), old, old);
    const manifest = join(dir, ".git", "manifest");
    expect(save(dir, manifest)).toBe(3);
    const now = new Date();
    utimesSync(join(dir, "odd\nname.rs"), now, now);
    expect(restore(dir, manifest)).toEqual({ restored: 3, changed: 0 });
    expect(mtime(join(dir, "odd\nname.rs"))).toBe(old.getTime());
  });
});
