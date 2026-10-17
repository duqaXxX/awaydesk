/**
 * The Slack provider's identity (`ChatProvider.identity`) is the workspace and the bot that
 * `auth.test` names, known once the provider is built and before any connection opens.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { slackChat } from "../../../src/chat/slack/module.ts";
import type { ChatContext } from "../../../src/core/port.ts";
import { FakeClock, FakeSlack } from "../../support/fake-slack.ts";

const BOT_TOKEN = `${"xox"}b-000-fake`;
const APP_TOKEN = `${"xap"}p-000-fake`;

async function identityOf(auth: Record<string, unknown>): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "awaydesk-identity-"));
  try {
    const slack = new FakeSlack();
    slack.responses["auth.test"] = { ok: true, ...auth };
    const clock = new FakeClock();
    const context: ChatContext = {
      variables: {
        SLACK_BOT_TOKEN: BOT_TOKEN,
        SLACK_APP_TOKEN: APP_TOKEN,
        SLACK_OWNER_USER_ID: "U000ALICE",
      },
      allowedRoot: "/",
      scratchDir: join(scratch, "uploads"),
      clock,
      steady: clock,
      core: () => assert.fail("the core was read"),
    };
    const chat = await slackChat({
      clients: { bot: () => [slack, slack], owner: () => assert.fail("no user token") },
      // Built with the provider, connected by `start`: the identity is known before it.
      receiver: () => ({
        init: () => {},
        start: async () => assert.fail("the connection was opened"),
        stop: async () => {},
      }),
    }).build(context);
    return chat.identity;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the identity is the workspace and the bot auth.test names", async () => {
  assert.equal(await identityOf({ team_id: "T000ACME", user_id: "U000BOT" }), "T000ACME:U000BOT");
});

test("another app in the same workspace has another identity", async () => {
  assert.notEqual(
    await identityOf({ team_id: "T000ACME", user_id: "U000BOT" }),
    await identityOf({ team_id: "T000ACME", user_id: "U000BOT2" }),
  );
});
