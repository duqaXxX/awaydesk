#!/usr/bin/env node
/**
 * `awaydesk`: the file `bin` in `package.json` names, and the one the LaunchAgent runs. It checks
 * the Node, then loads the daemon (`daemon.ts`).
 *
 * It has no static import, and the modules it loads before it knows the Node is new enough
 * (`node-version.ts`, `version.ts`, `log.ts`) name `node:fs` and each other only. An ES module
 * graph is linked whole before any module runs: a named import that an old Node lacks, such as
 * `parseEnv` of `node:util` on Node 18, would end the process with a `SyntaxError` at link time,
 * before a guard anywhere in the graph could run (measured on 2026-10-17, Node 18.19.0). The
 * daemon's own graph is loaded only after the check. `test/node-version.test.ts` holds both
 * rules.
 *
 * The file is the process's entry whenever it loads, a symlink in `node_modules/.bin` included, so
 * nothing here depends on `import.meta.main`, which an older Node lacks (it is `@since v22.18.0`).
 */
const { nodeRefusal } = await import("./node-version.ts");
const refusal = nodeRefusal(process.versions.node);

if (refusal === null) {
  const { start } = await import("./daemon.ts");
  start();
} else {
  const { getLogger } = await import("./log.ts");
  getLogger("awaydesk.main").error(refusal);
  // A status, not `process.exit`: a write to a pipe can still be pending on macOS.
  process.exitCode = 1;
}
