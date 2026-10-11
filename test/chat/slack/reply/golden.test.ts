/**
 * The Slack seam, on every recorded SDK stream: the Slack calls the reply sink makes for the
 * renderer's calls are the ones `test/golden/slack/<name>.json` holds. The renderer's calls are
 * read from the reply golden, so this test fails for a change in the sink alone. The files are
 * snapshots written by `npm run golden` (`test/support/golden.ts` says what they hold and the
 * discipline of the replay).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { golden, goldenNames, type Json, sdkRecordings } from "../../../support/fixtures.ts";
import { slackGolden } from "../../../support/golden.ts";

test("there is a slack golden for every recording, and for nothing else", () => {
  assert.deepEqual(goldenNames("slack"), sdkRecordings());
});

for (const name of sdkRecordings()) {
  test(`the slack calls of ${name} are the recorded ones`, async () => {
    const expected = golden("slack", name);
    const made = await slackGolden(name, golden("reply", name));
    // Call for call first, so that a difference names the call it starts at.
    const calls = made.slack_calls as Json[];
    const wanted = expected.slack_calls as Json[];
    for (const [index, call] of wanted.entries()) {
      assert.deepEqual(calls[index], call, `Slack call ${index} of ${name}`);
    }
    assert.deepEqual(made, expected);
  });
}
