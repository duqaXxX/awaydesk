/**
 * Assembles the package published to the npm registry in a folder of its own, so that the
 * registry's page shows `npm/README.md` and the repository keeps its own README.
 *
 *     npm run build:npm        # builds dist/, then runs this: writes build/npm/awaydesk/
 *     npm publish build/npm/awaydesk
 *
 * npm always packs the README at the root of the folder it publishes (docs.npmjs.com,
 * package.json, "files", read 2026-10-17), and has no field that names another one, so the
 * published README is chosen by publishing another folder. The mechanism is seedeep's
 * (`apps/server/scripts/build-npm.ts`): it only arranges files, and publishing stays a separate
 * act. The README's `{{VERSION}}` becomes the version, so its links point at that version's tag
 * and the page keeps showing what it showed when `main` changes.
 *
 * Plain JavaScript importing Node's standard library only, like the other scripts here.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The fields of the repository's package.json that the published one keeps. */
export const KEPT_FIELDS = [
  "name",
  "version",
  "description",
  "license",
  "repository",
  "type",
  "bin",
  "engines",
  "dependencies",
];

/** Besides package.json, README.md and LICENSE, which npm always packs. */
export const PACKED = ["dist", "slack-app-manifest.json"];

/**
 * The published package.json: the kept fields of `manifest`, in that order, and `files`. No
 * scripts (the folder holds a built `dist`), no devDependencies.
 * @param {Record<string, unknown>} manifest
 * @returns {Record<string, unknown>}
 */
export function publishedManifest(manifest) {
  /** @type {Record<string, unknown>} */
  const published = {};
  for (const field of KEPT_FIELDS) {
    if (manifest[field] === undefined) throw new Error(`package.json has no ${field}`);
    published[field] = manifest[field];
  }
  published.files = PACKED;
  return published;
}

/**
 * Writes the package of the repository at `root` into `out`, replacing what `out` held. Throws,
 * writing nothing, when `dist` has not been built.
 * @param {{ root: string; out: string }} paths
 */
export function assemble({ root, out }) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const published = publishedManifest(manifest);
  const bin = Object.values(/** @type {Record<string, string>} */ (manifest.bin));
  for (const entry of bin) {
    if (!existsSync(join(root, entry))) {
      throw new Error(`${entry} does not exist: run \`npm run build\` first`);
    }
  }
  const readme = readFileSync(join(root, "npm", "README.md"), "utf8").replaceAll(
    "{{VERSION}}",
    String(manifest.version),
  );
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  writeFileSync(join(out, "README.md"), readme);
  cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
  for (const path of PACKED) cpSync(join(root, path), join(out, path), { recursive: true });
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const out = join("build", "npm", "awaydesk");
  assemble({ root: ".", out });
  process.stdout.write(`${out}\n`);
}
