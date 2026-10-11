/**
 * The reply seam, on every recorded SDK stream: the calls the renderer makes on its sink are the
 * ones `test/golden/reply/<name>.json` holds, one for one. The files are snapshots written by
 * `npm run golden` (`test/support/golden.ts` says what they hold).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { golden, goldenNames, sdkRecordings } from "../../support/fixtures.ts";
import { replyGolden } from "../../support/golden.ts";

test("there is a reply golden for every recording, and for nothing else", () => {
  assert.deepEqual(goldenNames("reply"), sdkRecordings());
});

for (const name of sdkRecordings()) {
  test(`the sink calls of ${name} are the recorded ones [whole]`, async () => {
    assert.deepEqual((await replyGolden(name)).whole, golden("reply", name).whole);
  });

  test(`the sink calls of ${name} are the recorded ones [turns]`, async () => {
    assert.deepEqual((await replyGolden(name)).turns, golden("reply", name).turns);
  });
}
