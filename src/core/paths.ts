/** A path the owner wrote, read as Python's `Path(...).expanduser().resolve()` read it. */
import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { errorCode } from "../values.ts";

const SEPARATORS = process.platform === "win32" ? /[\\/]+/ : /\/+/;

/**
 * `~` and `~/x` to the home directory, as `Path.expanduser` does (`~user` is not expanded). Joined
 * as text: `path.join` would fold a `link/..` that the disk has to follow first.
 */
export function expandUser(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  return homedir().replace(/\/+$/, "") + path.slice(1) || "/";
}

/**
 * `posixpath._joinrealpath` of Python 3.12, not strict: `target` read from `start` one name at a
 * time, each link followed where it stands, so a `..` goes up from where the link led. A name
 * that cannot be looked at is kept as written. Returns the path and whether it is resolved: a
 * loop of links ends the walk, with the rest kept as written.
 */
function joinReal(
  start: string,
  target: string,
  seen: Map<string, string | null>,
): [path: string, resolved: boolean] {
  let path = start;
  let rest = target;
  if (isAbsolute(rest)) {
    path = parse(rest).root;
    rest = rest.slice(path.length);
  }
  const names = rest.split(SEPARATORS);
  for (const [index, name] of names.entries()) {
    if (name === "" || name === ".") continue;
    if (name === "..") {
      path = dirname(path);
      continue;
    }
    const next = join(path, name);
    let isLink = false;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (errorCode(error) === undefined) throw error;
    }
    if (!isLink) {
      path = next;
      continue;
    }
    const after = names.slice(index + 1);
    const known = seen.get(next);
    if (known === null) return [join(next, ...after), false];
    if (known !== undefined) {
      path = known;
      continue;
    }
    seen.set(next, null);
    const [led, resolved] = joinReal(path, readlinkSync(next), seen);
    if (!resolved) return [join(led, ...after), false];
    path = led;
    seen.set(next, path);
  }
  return [path, true];
}

/**
 * Absolute, with every symlink resolved as far as the path exists, as `Path.resolve()` does: the
 * spelling the owner wrote is kept where no link stands. Never `path.resolve`, which folds
 * `link/..` as text before the link is followed and names another folder than the kernel
 * reaches, nor `realpathSync.native`, which fails on a part that is not there and so leaves
 * what follows it unread.
 */
export function resolvePath(path: string): string {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  return joinReal("", absolute, new Map())[0];
}
