/**
 * Writes `test/golden/` again from the code as it is: `npm run golden`. Files of a recording that
 * is gone are removed. Read the diff it leaves before committing it: it is every change to a reply.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN, sdkRecordings } from "./fixtures.ts";
import { dump, replyGolden, slackGolden } from "./golden.ts";

for (const seam of ["reply", "slack"]) {
  rmSync(join(GOLDEN, seam), { recursive: true, force: true });
  mkdirSync(join(GOLDEN, seam), { recursive: true });
}
for (const name of sdkRecordings()) {
  const reply = await replyGolden(name);
  writeFileSync(join(GOLDEN, "reply", `${name}.json`), dump(reply));
  writeFileSync(join(GOLDEN, "slack", `${name}.json`), dump(await slackGolden(name, reply)));
}
