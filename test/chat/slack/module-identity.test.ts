/**
 * The Slack provider's identities (`ChatProvider.identities`) are the workspace and the bot that
 * `auth.test` names, and the app-level token Socket Mode connects with (hashed, never the token
 * itself). Both are known once the provider is built and before any connection opens.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { slackChat } from "../../../src/chat/slack/module.ts";
import type { ChatContext } from "../../../src/core/port.ts";
import { FakeClock, FakeSlack } from "../../support/fake-slack.ts";

const BOT_TOKEN = `${"xox"}b-000-fake`;
const APP_TOKEN = `${"xap"}p-000-fake`;

async function identitiesOf(
  auth: Record<string, unknown>,
  appToken: string = APP_TOKEN,
): Promise<readonly string[]> {
  const scratch = mkdtempSync(join(tmpdir(), "awaydesk-identity-"));
  try {
    const slack = new FakeSlack();
    slack.responses["auth.test"] = { ok: true, ...auth };
    const clock = new FakeClock();
    const context: ChatContext = {
      variables: {
        SLACK_BOT_TOKEN: BOT_TOKEN,
        SLACK_APP_TOKEN: appToken,
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
    return chat.identities;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const hashed = (token: string): string =>
  `app-token:${createHash("sha256").update(token).digest("hex")}`;

test("the identities are the workspace and bot auth.test names, and the app token's hash", async () => {
  assert.deepEqual(await identitiesOf({ team_id: "T000ACME", user_id: "U000BOT" }), [
    "T000ACME:U000BOT",
    hashed(APP_TOKEN),
  ]);
});

test("no identity holds the token itself", async () => {
  const keys = await identitiesOf({ team_id: "T000ACME", user_id: "U000BOT" });
  for (const key of keys) assert.ok(!key.includes(APP_TOKEN), key);
});

test("another app in the same workspace has another bot key, and the same app token shares its key", async () => {
  const [bot, app] = await identitiesOf({ team_id: "T000ACME", user_id: "U000BOT" });
  const [otherBot, sameApp] = await identitiesOf({ team_id: "T000ACME", user_id: "U000BOT2" });
  assert.notEqual(otherBot, bot);
  // A copied `.env` with a new bot token and the old app token collides on this key.
  assert.equal(sameApp, app);
});

test("another app token has another app key", async () => {
  const [, app] = await identitiesOf({ team_id: "T000ACME", user_id: "U000BOT" });
  const [, other] = await identitiesOf(
    { team_id: "T000ACME", user_id: "U000BOT" },
    `${"xap"}p-111-other`,
  );
  assert.notEqual(other, app);
});
