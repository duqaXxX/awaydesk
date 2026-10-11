/**
 * Writes `test/golden/` again from the code as it is: `npm run golden`. Everything is computed
 * before anything is removed, so a failure leaves the files as they were, and the directory is
 * written whole, so a file of a recording that is gone goes with it. Read the diff it leaves
 * before committing it: it is every change to a reply.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN, sdkRecordings } from "./fixtures.ts";
import { dump, replyGolden, slackGolden } from "./golden.ts";

const files = new Map<string, string>();
for (const name of sdkRecordings()) {
  const reply = await replyGolden(name);
  files.set(join("reply", `${name}.json`), dump(reply));
  files.set(join("slack", `${name}.json`), dump(await slackGolden(name, reply)));
}
rmSync(GOLDEN, { recursive: true, force: true });
for (const seam of ["reply", "slack"]) mkdirSync(join(GOLDEN, seam), { recursive: true });
for (const [path, text] of files) writeFileSync(join(GOLDEN, path), text);
