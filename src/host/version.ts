/**
 * The version of awaydesk that runs: the `version` of the package's own `package.json`. The file
 * sits two levels above this one both in the sources (`src/host/`) and in the installed package
 * (`dist/host/`), so a run from a checkout reads the checkout's and an installed copy its own.
 */
import { readFileSync } from "node:fs";

/** The `version` field of the package's `package.json`; throws when the file has none. */
export function installedVersion(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const version =
    typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : null;
  if (typeof version !== "string" || version === "") {
    throw new Error("package.json has no version");
  }
  return version;
}
