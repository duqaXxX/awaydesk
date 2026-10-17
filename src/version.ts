/**
 * The version of awaydesk that runs, and the address of its setup guide. The version is the
 * `version` of the package's own `package.json`, which sits one level above this file both in the
 * sources (`src/`) and in the installed package (`dist/`), so a run from a checkout reads the
 * checkout's and an installed copy its own. Any layer may import this file: a text that sends the
 * owner to the guide names the page of the version that runs, since the package no longer carries
 * `docs/`.
 */
import { readFileSync } from "node:fs";

const REPOSITORY = "https://github.com/duqaXxX/awaydesk";

/**
 * The sections of `docs/setup.md` a text of the core sends the owner to, by their anchor on
 * GitHub; a module keeps the anchors of its own sections. `test/version.test.ts` holds each to a
 * heading of the page.
 */
export const SETUP_SECTIONS = {
  nodeOfItsOwn: "a-node-of-its-own",
  configuration: "part-2-configuration",
  protectedFolders: "folders-macos-protects",
} as const;

let version: string | null = null;

/**
 * The `version` of the package whose `package.json` is `manifest`, or null when it cannot be read
 * or has none. It names `node:fs` alone: this file is loaded before the Node is known to be new
 * enough (`main.ts`).
 */
export function packageVersion(manifest: string | URL): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const found =
      typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : null;
    return typeof found === "string" && found !== "" ? found : null;
  } catch {
    return null;
  }
}

/** The `version` field of the package's `package.json`; throws when the file has none. */
export function installedVersion(): string {
  if (version !== null) return version;
  const found = packageVersion(new URL("../package.json", import.meta.url));
  if (found === null) throw new Error("package.json has no version");
  version = found;
  return version;
}

/** The address of `section` of the setup guide, as published with the version that runs. */
export function setupGuide(section: string): string {
  return `${REPOSITORY}/blob/v${installedVersion()}/docs/setup.md#${section}`;
}
