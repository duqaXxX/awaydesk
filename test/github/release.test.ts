/**
 * The release workflow's checks on a tag and the notes of its GitHub Release
 * (`.github/scripts/release.mjs`), and the workflow's own guards read from its file.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Plain JavaScript run on the runner's own node; the tsconfig does not read .mjs files, so the
// module is loaded by URL and given the types its JSDoc declares.
const SCRIPT_URL = new URL("../../.github/scripts/release.mjs", import.meta.url);
const SCRIPT = fileURLToPath(SCRIPT_URL);
const { refusal, releaseNotes } = (await import(SCRIPT_URL.href)) as {
  refusal: (tag: string, version: string, changelog: string) => string | null;
  releaseNotes: (changelog: string, version: string) => string | null;
};
const WORKFLOW = readFileSync(
  join(import.meta.dirname, "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
);

const CHANGELOG = [
  "# Changelog",
  "",
  "## Unreleased",
  "",
  "### Fixed",
  "",
  "- Something after the release.",
  "",
  "## [0.2.0] - 2026-11-02",
  "",
  "### Added",
  "",
  "- `!awaydesk update`.",
  "",
  "### Fixed",
  "",
  "- A fix.",
  "",
  "## [0.1.0] - 2026-10-20",
  "",
  "- The first release.",
  "",
].join("\n");

test("a tag that names package.json's version, with its changelog section, is accepted", () => {
  assert.equal(refusal("v0.2.0", "0.2.0", CHANGELOG), null);
  assert.equal(refusal("v0.1.0", "0.1.0", CHANGELOG), null);
});

test("a tag that does not name package.json's version is refused", () => {
  assert.match(refusal("v0.2.1", "0.2.0", CHANGELOG) as string, /v0\.2\.1 is not v0\.2\.0/);
  assert.match(refusal("0.2.0", "0.2.0", CHANGELOG) as string, /is not v0\.2\.0/);
});

test("a version with no dated section in the changelog is refused", () => {
  assert.match(refusal("v0.3.0", "0.3.0", CHANGELOG) as string, /no "## \[0\.3\.0\]/);
  assert.match(
    refusal("v0.3.0", "0.3.0", "## [0.3.0]\n\n- Undated.\n") as string,
    /no "## \[0\.3\.0\] - YYYY-MM-DD"/,
  );
  // The dot is a dot: 0x3x0 is not 0.3.0.
  assert.notEqual(refusal("v0.3.0", "0.3.0", "## [0x3x0] - 2026-11-02\n"), null);
});

test("an empty section is refused: the release would have no notes", () => {
  assert.match(
    refusal(
      "v0.3.0",
      "0.3.0",
      "## Unreleased\n\n## [0.3.0] - 2026-11-02\n\n## [0.2.0] - 2026-11-01\n",
    ) as string,
    /section "## \[0\.3\.0\]" of docs\/CHANGELOG\.md is empty/,
  );
});

test("a version that is not x.y.z is refused", () => {
  assert.match(refusal("v1.0.0-rc.1", "1.0.0-rc.1", CHANGELOG) as string, /no x\.y\.z version/);
});

test("the notes are the section under the version's heading, up to the next heading", () => {
  assert.equal(
    releaseNotes(CHANGELOG, "0.2.0"),
    "### Added\n\n- `!awaydesk update`.\n\n### Fixed\n\n- A fix.",
  );
  assert.equal(releaseNotes(CHANGELOG, "0.1.0"), "- The first release.");
  assert.equal(releaseNotes(CHANGELOG, "0.9.0"), null);
});

/** The script run as the workflow runs it, in a folder holding `version` and `changelog`. */
function run(t: { after(fn: () => void): void }, args: string[], version: string) {
  const folder = mkdtempSync(join(tmpdir(), "awaydesk-release-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, "package.json"), JSON.stringify({ version }));
  mkdirSync(join(folder, "docs"));
  writeFileSync(join(folder, "docs", "CHANGELOG.md"), CHANGELOG);
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: folder, encoding: "utf8" });
}

test("check exits 0 on a good tag and 1 with the reason on a bad one", (t) => {
  assert.equal(run(t, ["check", "v0.2.0"], "0.2.0").status, 0);
  const bad = run(t, ["check", "v0.2.1"], "0.2.0");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^release: the tag v0\.2\.1 is not v0\.2\.0/);
});

test("notes prints the section", (t) => {
  const result = run(t, ["notes", "v0.1.0"], "0.1.0");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "- The first release.\n");
});

/** The text of the workflow's job `name`, up to the next job. */
function job(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, name);
  const next = WORKFLOW.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  return next === -1 ? WORKFLOW.slice(start) : WORKFLOW.slice(start, start + 1 + next);
}

test("only the publish job may ask for an OIDC token, and no npm token is stored", () => {
  assert.match(job("publish"), /^ {6}id-token: write$/m);
  for (const other of ["verify", "check", "github-release"]) {
    assert.doesNotMatch(job(other), /id-token/, other);
  }
  assert.doesNotMatch(WORKFLOW, /NPM_TOKEN|NODE_AUTH_TOKEN:/);
});

test("the publish job runs no dependency's install script and uses no cache", () => {
  assert.match(job("publish"), /^ {6}- run: npm ci --ignore-scripts$/m);
  assert.match(job("publish"), /^ {10}package-manager-cache: false$/m);
});

test("the workflow reads the tag from the environment, never interpolated into a script", () => {
  const runs = WORKFLOW.split("\n").filter((line) => /\$\{\{/.test(line));
  for (const line of runs) {
    assert.match(line, /^\s*(name|group|[A-Z_]+|runs-on):/, line);
  }
});
