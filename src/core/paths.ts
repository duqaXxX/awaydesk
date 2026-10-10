/** A path the owner wrote, read as Python's `Path(...).expanduser().resolve()` read it. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { errorCode } from "../values.ts";

/**
 * `~` and `~/x` to the home directory, as `Path.expanduser` does (`~user` is not expanded). Joined
 * as text: `path.join` would fold a `link/..` that the disk has to follow first.
 */
export function expandUser(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  return homedir().replace(/\/+$/, "") + path.slice(1) || "/";
}

/**
 * Absolute, symlinks resolved as far as the path exists, as `Path.resolve()` does. Made absolute
 * as text and never normalized, since `resolve` would fold `link/..` before the link is followed
 * and name another folder than the one the kernel reaches; `realpathSync.native` is libuv's
 * `realpath(3)`, which follows it, where the JavaScript `realpathSync` normalizes first. What does
 * not exist is kept, with the `..` in it folded, as Python does.
 */
export function resolvePath(path: string): string {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}/${path}`;
  const rest: string[] = [];
  let head = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(head);
      if (parent === head) return absolute;
      rest.unshift(basename(head));
      head = parent;
    }
  }
}
