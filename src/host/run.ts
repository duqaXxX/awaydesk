/** Runs a system command for the host layer, with no shell between, and waits for it. */
import { spawnSync } from "node:child_process";
import type { Run } from "./service/seam.ts";

/** `Run` on the real machine: a command that cannot start reports status null and why. */
export const runCommand: Run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error !== undefined) {
    return { status: null, stdout: "", stderr: result.error.message };
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
