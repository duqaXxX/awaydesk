/**
 * The shape of each Slack token is the Slack module's to check, when the module is built and before
 * any call to Slack (the core's configuration only hands the values over).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { slackChat } from "../../../src/chat/slack/module.ts";
import { type ChatContext, ConfigError } from "../../../src/core/port.ts";
import { FakeClock } from "../../support/fake-slack.ts";

const BOT = `${"xox"}b-000-fake`;
const APP = `${"xap"}p-000-fake`;
const USER = `${"xox"}p-000-fake`;

function contextOf(variables: Record<string, string>): ChatContext {
  const clock = new FakeClock();
  return {
    variables,
    allowedRoot: "/",
    scratchDir: "/scratch",
    clock,
    steady: clock,
    core: () => assert.fail("the core was read"),
  };
}

/** The entry over clients that fail the test when Slack is reached. */
const unreached = slackChat({
  clients: {
    bot: () => assert.fail("Slack was reached"),
    owner: () => assert.fail("Slack was reached"),
  },
});

const OWNER = { SLACK_OWNER_USER_ID: "U000ALICE" };

const refusals: [string, Record<string, string>, string][] = [
  [
    "swapped tokens",
    { SLACK_BOT_TOKEN: APP, SLACK_APP_TOKEN: BOT },
    "SLACK_BOT_TOKEN must be the Bot User OAuth Token (xoxb-...)",
  ],
  [
    "an app token of the wrong kind",
    { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: BOT },
    "SLACK_APP_TOKEN must be the app-level token (xapp-...)",
  ],
  [
    "a user token of the wrong kind",
    { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, SLACK_USER_TOKEN: BOT },
    "SLACK_USER_TOKEN must be the User OAuth Token (xoxp-...)",
  ],
];

for (const [label, variables, message] of refusals) {
  test(`refuses ${label} before calling Slack`, async () => {
    await assert.rejects(
      unreached.build(contextOf({ ...OWNER, ...variables })),
      (error: unknown) => error instanceof ConfigError && error.message === message,
    );
  });
}

test("a user token of the right kind passes the check", async () => {
  // It reaches Slack, which the entry here refuses to be: the check itself did not stop it.
  await assert.rejects(
    unreached.build(
      contextOf({ ...OWNER, SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP, SLACK_USER_TOKEN: USER }),
    ),
    (error: unknown) => !(error instanceof ConfigError),
  );
});
