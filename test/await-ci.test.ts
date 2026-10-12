import { describe, expect, test } from "bun:test";
import { type Run, verdict } from "../actions/await-ci/await-ci";

const sha = "a".repeat(40);
const run = (over: Partial<Run>): Run => ({
  id: 1,
  run_number: 1,
  event: "push",
  head_branch: "main",
  head_sha: sha,
  status: "completed",
  conclusion: "success",
  html_url: "u",
  ...over,
});

describe("await-ci verdict", () => {
  test("green only for a successful run of the branch on exactly this commit", () => {
    expect(verdict(sha, "main", [run({})]).state).toBe("green");
    expect(verdict(sha, "main", [run({ head_sha: "b".repeat(40) })]).state).toBe("pending");
    expect(verdict(sha, "main", [run({ event: "pull_request", head_branch: "feature" })]).state).toBe("pending");
    expect(verdict(sha, "master", [run({ head_branch: "master" })]).state).toBe("green");
  });

  test("the newest run decides", () => {
    const older = run({ run_number: 1, conclusion: "failure" });
    const newer = run({ run_number: 2, conclusion: "success" });
    expect(verdict(sha, "main", [older, newer]).state).toBe("green");
    expect(verdict(sha, "main", [run({ run_number: 3, status: "in_progress", conclusion: null }), newer]).state).toBe("pending");
  });

  test("failed and cancelled runs are red", () => {
    expect(verdict(sha, "main", [run({ conclusion: "failure" })]).state).toBe("red");
    expect(verdict(sha, "main", [run({ conclusion: "cancelled" })]).state).toBe("red");
  });
});
