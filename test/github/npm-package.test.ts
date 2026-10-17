/**
 * The package published to npm (`.github/scripts/npm-package.mjs`): assembled in a folder of its
 * own, with `npm/README.md` as its README, its links pinned to the version's tag.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Plain JavaScript run on the runner's own node, loaded by URL with the types its JSDoc declares.
const { assemble, publishedManifest, KEPT_FIELDS } = (await import(
  new URL("../../.github/scripts/npm-package.mjs", import.meta.url).href
)) as {
  assemble: (paths: { root: string; out: string }) => void;
  publishedManifest: (manifest: Record<string, unknown>) => Record<string, unknown>;
  KEPT_FIELDS: string[];
};

const ROOT = join(import.meta.dirname, "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const NPM_README = readFileSync(join(ROOT, "npm", "README.md"), "utf8");

test("the published package.json keeps what an install needs and nothing to build with", () => {
  const published = publishedManifest(MANIFEST);
  assert.deepEqual(Object.keys(published), [...KEPT_FIELDS, "files"]);
  assert.deepEqual(published.dependencies, MANIFEST.dependencies);
  assert.deepEqual(published.bin, MANIFEST.bin);
  assert.deepEqual(published.engines, MANIFEST.engines);
  // npm's search reads them.
  assert.deepEqual(published.keywords, MANIFEST.keywords);
  assert.equal(published.version, MANIFEST.version);
  assert.equal(published.scripts, undefined);
  assert.equal(published.devDependencies, undefined);
  assert.deepEqual(published.files, ["dist", "slack-app-manifest.json"]);
});

test("a package.json missing a field the package needs is refused", () => {
  const { engines: _, ...partial } = MANIFEST;
  assert.throws(() => publishedManifest(partial), /package\.json has no engines/);
});

test("npm's README links to GitHub by absolute URL, pinned to the version's tag", () => {
  const links = [...NPM_README.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1] as string);
  assert.ok(links.length > 0);
  for (const link of links) assert.match(link, /^https:\/\//, link);
  for (const link of links.filter((url) => url.includes("/blob/"))) {
    assert.match(link, /\/blob\/v\{\{VERSION\}\}\//, link);
  }
});

test("npm's README links the guide's part on the Slack app and the manifest", () => {
  assert.ok(NPM_README.includes("/blob/v{{VERSION}}/docs/setup.md#part-1-the-slack-app)"));
  assert.ok(NPM_README.includes("/blob/v{{VERSION}}/slack-app-manifest.json)"));
});

test("npm's README names the commands the package has", () => {
  for (const command of [
    "npm install -g awaydesk",
    "awaydesk service install",
    "awaydesk service restart",
  ]) {
    assert.ok(NPM_README.includes(command), command);
  }
});

/** A repository with a built `dist`, as `npm run build:npm` leaves it before this script. */
function repository(t: { after(fn: () => void): void }, built = true): string {
  const root = mkdtempSync(join(tmpdir(), "awaydesk-npm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(root, "LICENSE"), "MIT");
  writeFileSync(join(root, "slack-app-manifest.json"), "{}");
  writeFileSync(join(root, "README.md"), "the repository's own README");
  mkdirSync(join(root, "npm"));
  writeFileSync(join(root, "npm", "README.md"), NPM_README);
  if (built) {
    mkdirSync(join(root, "dist", "host"), { recursive: true });
    writeFileSync(join(root, "dist", "main.js"), "#!/usr/bin/env node\n");
    writeFileSync(join(root, "dist", "host", "version.js"), "");
  }
  return root;
}

test("the folder holds the package, with npm's README and its version in the links", (t) => {
  const root = repository(t);
  const out = join(root, "build", "npm", "awaydesk");
  writeFileSync(join(root, "stale"), "");
  assemble({ root, out });
  assert.deepEqual(readdirSync(out).sort(), [
    "LICENSE",
    "README.md",
    "dist",
    "package.json",
    "slack-app-manifest.json",
  ]);
  assert.ok(existsSync(join(out, "dist", "host", "version.js")));
  const readme = readFileSync(join(out, "README.md"), "utf8");
  assert.ok(!readme.includes("{{VERSION}}"));
  assert.ok(readme.includes(`/blob/v${MANIFEST.version}/docs/setup.md`));
  assert.deepEqual(
    JSON.parse(readFileSync(join(out, "package.json"), "utf8")),
    publishedManifest(MANIFEST),
  );
});

test("assembling again replaces the folder, and an unbuilt dist writes nothing", (t) => {
  const root = repository(t);
  const out = join(root, "out");
  mkdirSync(out);
  writeFileSync(join(out, "left-over"), "");
  assemble({ root, out });
  assert.ok(!existsSync(join(out, "left-over")));
  const unbuilt = repository(t, false);
  assert.throws(() => assemble({ root: unbuilt, out: join(unbuilt, "out") }), /npm run build/);
  assert.ok(!existsSync(join(unbuilt, "out")));
});
