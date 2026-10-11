/** What the Claude back end supports: the reference for every capability of the seam. */
import type { Capabilities } from "../seam.ts";

export const CAPABILITIES: Capabilities = Object.freeze({
  // The SDK's `EffortLevel`.
  effortLevels: Object.freeze(["low", "medium", "high", "xhigh", "max"]),
  // The TypeScript SDK changes the effort of a live session (`applyFlagSettings`, no reconnect,
  // SDK 0.3.296): 36 ms in the spike's measurement, 28 ms in the back end's own live check, both
  // on 2026-10-10.
  liveEffort: true,
  permissionModes: Object.freeze({
    default: "default",
    auto: "auto",
    bypass: "bypassPermissions",
  }),
  subagents: true,
  backgroundTasks: true,
  compaction: true,
  questions: true,
  changedInput: true,
  usageLimits: true,
  models: true,
  commands: true,
  promptDuringTurn: true,
  sessionListing: true,
  folderTrust: true,
});
