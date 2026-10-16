/**
 * The release workflow's checks on a tag, and the notes of its GitHub Release.
 *
 *     node .github/scripts/release.mjs check v0.1.0   # exits 1 with the reason when the tag is wrong
 *     node .github/scripts/release.mjs notes v0.1.0   # prints the GitHub Release body (releaseBody)
 *
 * Both read `package.json` and `docs/CHANGELOG.md` from the working directory. A tag releases the
 * version `package.json` holds, and only once `docs/CHANGELOG.md` has its section,
 * `## [x.y.z] - YYYY-MM-DD` as Keep a Changelog 1.1.0 writes it.
 *
 * Plain JavaScript importing Node's standard library only, like `sdk-release-report.mjs`: the
 * release job that writes the notes runs it on the runner's own `node`.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/;

// The longest body GitHub's API takes for a release: it answers 422 "body is too long (maximum is
// 125000 characters)". Reported by projects that hit it (intuit/auto#2418,
// objectstack-ai/objectstack#5290); GitHub's own documentation was not found to state it.
export const NOTES_LIMIT = 125000;

/** The `## [version] - date` heading of `version`, as a pattern for one line. */
function heading(version) {
  return new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
}

/**
 * Why `tag` cannot release the package whose `package.json` says `version` with this
 * `changelog`, or null when it can.
 * @param {string} tag
 * @param {string} version
 * @param {string} changelog
 * @returns {string | null}
 */
export function refusal(tag, version, changelog) {
  if (!VERSION.test(version)) return `package.json holds no x.y.z version: "${version}"`;
  if (tag !== `v${version}`) return `the tag ${tag} is not v${version}, the version of package.json`;
  if (!heading(version).test(changelog)) {
    return `docs/CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section`;
  }
  if (releaseNotes(changelog, version) === "") {
    return `the section "## [${version}]" of docs/CHANGELOG.md is empty`;
  }
  return null;
}

/**
 * The body of `version`'s section of `changelog`: from under its heading to the next `## `
 * heading, trimmed. Null when the section is missing.
 * @param {string} changelog
 * @param {string} version
 * @returns {string | null}
 */
export function releaseNotes(changelog, version) {
  const match = heading(version).exec(changelog);
  if (match === null) return null;
  const rest = changelog.slice(match.index + match[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/**
 * The body of the GitHub Release of `version`: its changelog section, or, when that is longer
 * than GitHub takes, a link to the section in the changelog at `tag` on `repository` (a GitHub
 * URL).
 * @param {string} changelog
 * @param {string} version
 * @param {string} tag
 * @param {string} repository
 * @returns {string}
 */
export function releaseBody(changelog, version, tag, repository) {
  const notes = releaseNotes(changelog, version) ?? "";
  if (notes.length <= NOTES_LIMIT) return notes;
  return (
    `The changes of ${version} are longer than a release page holds: they are under ` +
    `\`## [${version}]\` in [docs/CHANGELOG.md](${repository}/blob/${tag}/docs/CHANGELOG.md).`
  );
}

/** The https URL of a package.json `repository` (`git+https://github.com/o/r.git`). */
function repositoryUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  return String(url).replace(/^git\+/, "").replace(/\.git$/, "");
}

function main([command, tag]) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const version = manifest.version;
  const changelog = readFileSync("docs/CHANGELOG.md", "utf8");
  const reason = typeof tag === "string" ? refusal(tag, String(version), changelog) : "no tag given";
  if (reason !== null) {
    process.stderr.write(`release: ${reason}\n`);
    return 1;
  }
  if (command === "check") return 0;
  if (command === "notes") {
    const body = releaseBody(changelog, version, tag, repositoryUrl(manifest.repository));
    process.stdout.write(`${body}\n`);
    return 0;
  }
  process.stderr.write("usage: node .github/scripts/release.mjs check|notes <tag>\n");
  return 2;
}

const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
