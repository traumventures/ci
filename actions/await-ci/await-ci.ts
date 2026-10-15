#!/usr/bin/env bun
/**
 * Is this commit of the default branch green? Deploy and release gates ask
 * before anything is built or published (actions/await-ci, workflow gate.yml).
 *
 *   bun await-ci.ts <sha> [--workflow ci.yml] [--branch main] [--wait <minutes>]
 *   bun await-ci.ts <sha> [--branch main] --branch-only
 *   exit 0 green, 1 red or not on the branch, 3 no result in time, 2 usage
 *
 * --branch-only checks only that the commit is on the branch: for a deploy or
 * release that runs the CI itself (a `ci` job calling the repository's
 * ci.yml), since CI no longer runs on its own on pushes to main.
 *
 * Green means: the commit is on the branch, and the newest run of the
 * workflow on that branch for exactly this commit (push or a manual dispatch)
 * concluded success. A run that skipped jobs because they passed before still
 * counts: its conclusion is success.
 *
 * Auth: GH_TOKEN or GITHUB_TOKEN (actions:read, contents:read), else `gh auth token`.
 */

export type Run = {
  id: number;
  run_number: number;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

export type Verdict =
  | { state: "green"; run: Run }
  | { state: "red"; run: Run; reason: string }
  | { state: "pending"; run?: Run; reason: string };

/** The verdict from the runs of one commit; pure, for the tests. */
export function verdict(sha: string, branch: string, runs: Run[]): Verdict {
  const relevant = runs
    .filter((r) => r.head_sha === sha && r.head_branch === branch && (r.event === "push" || r.event === "workflow_dispatch"))
    .sort((a, b) => b.run_number - a.run_number);
  const run = relevant[0];
  if (!run) return { state: "pending", reason: `no run on ${branch} for ${sha.slice(0, 12)} yet` };
  if (run.status !== "completed") return { state: "pending", run, reason: `the run is ${run.status}` };
  if (run.conclusion === "success") return { state: "green", run };
  return { state: "red", run, reason: `the run concluded ${run.conclusion ?? "without a conclusion"}` };
}

function option(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

function token(): string {
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const gh = Bun.spawnSync(["gh", "auth", "token"]);
  if (gh.exitCode !== 0) throw new Error("no GH_TOKEN/GITHUB_TOKEN and `gh auth token` failed");
  return gh.stdout.toString().trim();
}

function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const gh = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  if (gh.exitCode !== 0) throw new Error("set GITHUB_REPOSITORY (owner/name)");
  return gh.stdout.toString().trim();
}

async function api<T>(path: string, auth: string): Promise<T> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${path}`, {
    headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function main() {
  const args = process.argv.slice(2);
  const sha = args[0];
  const workflow = option(args, "--workflow", "ci.yml");
  const branch = option(args, "--branch", "main");
  const waitMinutes = Number(option(args, "--wait", "0"));
  const branchOnly = args.includes("--branch-only");
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !Number.isFinite(waitMinutes)) {
    console.error("usage: bun await-ci.ts <full sha> [--workflow ci.yml] [--branch main] [--wait <minutes>]");
    process.exit(2);
  }
  const repo = repository();
  const auth = token();

  const compare = await api<{ status: string }>(`${repo}/compare/${sha}...${branch}`, auth).catch(() => ({ status: "unknown commit" }));
  if (compare.status !== "identical" && compare.status !== "ahead") {
    console.log(`::error::${sha} is not on ${branch} (compare: ${compare.status}). Only commits of ${branch} are deployed or released.`);
    process.exit(1);
  }
  if (branchOnly) {
    console.log(`${sha.slice(0, 12)} is on ${branch}`);
    process.exit(0);
  }

  const deadline = Date.now() + waitMinutes * 60_000;
  let last = "";
  for (;;) {
    const { workflow_runs } = await api<{ workflow_runs: Run[] }>(
      `${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&branch=${encodeURIComponent(branch)}&per_page=50`,
      auth,
    );
    const result = verdict(sha, branch, workflow_runs);
    const where = result.run ? ` (${result.run.html_url})` : "";
    if (result.state === "green") {
      console.log(`${workflow} is green for ${sha.slice(0, 12)}${where}`);
      process.exit(0);
    }
    if (result.state === "red") {
      console.log(`::error::${workflow}: ${result.reason} for ${sha.slice(0, 12)}${where}. Fix ${branch} (or rerun a flaky run) first.`);
      process.exit(1);
    }
    if (result.reason !== last) console.log(`waiting: ${result.reason}${where}`);
    last = result.reason;
    if (Date.now() >= deadline) {
      console.log(`::error::${workflow}: ${result.reason}${where}; gave up after ${waitMinutes} min.`);
      process.exit(3);
    }
    await Bun.sleep(20_000);
  }
}

if (import.meta.main) await main();
