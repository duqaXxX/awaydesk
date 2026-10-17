/**
 * The program a service manager starts: which Node, which file, and the folders a session's
 * commands need on their `PATH`. Read from the command being run, so `awaydesk service install`
 * names the copy it was started from.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface Program {
  /** The Node to start, as found on `PATH`: a link such as Homebrew's survives an upgrade. */
  node: string;
  /** The real path of the entry file, `dist/main.js` of the installed package. */
  main: string;
  /** npm's global `bin` folder when the entry is a global install, else null. */
  npmBin: string | null;
}

/** The first executable file called `name` in the folders of `pathVariable`, or null. */
export function findOnPath(name: string, pathVariable: string): string | null {
  for (const folder of pathVariable.split(delimiter)) {
    if (folder === "") continue;
    const candidate = join(folder, name);
    try {
      // A folder passes the access check too.
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

// npm's folders page (read 2026-10-16): "Global installs on Unix systems go to
// `{prefix}/lib/node_modules`" and executables "are linked into `{prefix}/bin` on Unix".
const GLOBAL_ENTRY = /^(.*)\/lib\/node_modules\/awaydesk\/dist\/main\.js$/;

/**
 * The program of the running command: `entry` is `process.argv[1]` (npm's link in its `bin`
 * folder, resolved here), `pathVariable` the caller's `PATH`, `execPath` the fallback Node.
 */
export function programOf(entry: string, pathVariable: string, execPath: string): Program {
  const main = realpathSync(entry);
  const prefix = GLOBAL_ENTRY.exec(main)?.[1];
  return {
    node: findOnPath("node", pathVariable) ?? execPath,
    main,
    npmBin: prefix === undefined ? null : join(prefix, "bin"),
  };
}

/** The folders of the service's `PATH`: Node's own first, then npm's, then the system's. */
export function servicePath(program: Program, system: readonly string[]): string {
  const folders = [dirname(program.node), program.npmBin, ...system];
  return [...new Set(folders.filter((folder) => folder !== null))].join(":");
}

/** The package folder of the copy whose entry file is `main`: the folder above `dist/`. */
export function copyOf(main: string): string {
  return dirname(dirname(main));
}

/** The `version` of the package in `copy`, or null when its `package.json` cannot be read. */
export function copyVersion(copy: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null && "version" in parsed ? parsed.version : null;
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}
