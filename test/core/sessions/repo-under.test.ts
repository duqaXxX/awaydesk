/**
 * `repoUnder` builds a repository for the session tests. A git hook (the pre-push that runs this
 * suite from a linked worktree) hands every git it starts an absolute `GIT_DIR`, and `git init`
 * then re-initialises that repository instead of making the new one (git 2.54.0, 2026-10-11).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git, gitInit } from "../../support/git-layouts.ts";
import { repoUnder } from "./helpers.ts";

const REDIRECTS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];

test("repoUnder makes its own repository while a hook's GIT_DIR points at another", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "awaydesk-repo-under-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // The throwaway stands for the repository a hook names: it is never this checkout.
  const outer = gitInit(join(tmp, "outer"));
  const outerConfig = readFileSync(join(outer, ".git", "config"), "utf8");
  const outerHead = readFileSync(join(outer, ".git", "HEAD"), "utf8");

  const saved = REDIRECTS.map((name) => [name, process.env[name]] as const);
  process.env.GIT_DIR = join(outer, ".git");
  process.env.GIT_WORK_TREE = outer;
  let repo: string;
  try {
    repo = repoUnder(join(tmp, "channel"));
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.equal(readFileSync(join(outer, ".git", "config"), "utf8"), outerConfig);
  assert.equal(readFileSync(join(outer, ".git", "HEAD"), "utf8"), outerHead);
  assert.ok(existsSync(join(repo, ".git")), "the new repository is where it was asked for");
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "feature-x");
});
