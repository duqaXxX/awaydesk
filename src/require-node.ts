/**
 * Ends the process with status 1 and one line on stderr when the Node is older than
 * `MINIMUM_NODE`. `main.ts` imports it first: imports run in order, so this runs before the
 * modules after it are evaluated, and it does not rest on `import.meta.main`, which is the
 * thing an old Node lacks. On a supported Node it does nothing.
 */
import { getLogger } from "./log.ts";
import { nodeRefusal } from "./node-version.ts";

const refusal = nodeRefusal(process.versions.node);
if (refusal !== null) {
  getLogger("awaydesk.main").error(refusal);
  process.exit(1);
}
