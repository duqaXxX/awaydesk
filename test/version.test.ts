import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SETUP_SLACK_APP } from "../src/chat/slack/texts.ts";
import { installedVersion, SETUP_SECTIONS, setupGuide } from "../src/version.ts";

const ROOT = join(import.meta.dirname, "..");

test("the version is the one package.json holds", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  assert.equal(installedVersion(), manifest.version);
});

test("the guide's address names the setup page at the version's tag", () => {
  assert.equal(
    setupGuide(SETUP_SECTIONS.requirements),
    `https://github.com/duqaXxX/awaydesk/blob/v${installedVersion()}/docs/setup.md#requirements`,
  );
});

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces as hyphens. */
function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

test("every section a text sends the owner to is a heading of docs/setup.md", () => {
  const headings = readFileSync(join(ROOT, "docs", "setup.md"), "utf8")
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => anchor(line.replace(/^#+ /, "")));
  for (const section of [...Object.values(SETUP_SECTIONS), SETUP_SLACK_APP]) {
    assert.ok(headings.includes(section), `docs/setup.md has no heading for #${section}`);
  }
});
