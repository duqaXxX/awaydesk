/** `crossing`: a failed call crosses the seam as a `ChatError`, a cancelled one as it is. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatError } from "../../../src/chat/seam.ts";
import { crossing } from "../../../src/chat/slack/notice.ts";
import { Cancelled } from "../../../src/core/sessions/tasks.ts";
import { rejected } from "../../support/fake-slack.ts";

test("a failure of the call crosses as a chat error named by Slack's code", async () => {
  await assert.rejects(
    crossing(() => Promise.reject(rejected("msg_too_long"))),
    (error: unknown) => error instanceof ChatError && error.name === "msg_too_long",
  );
});

test("a cancelled call crosses as it is", async () => {
  const cancelled = new Cancelled();
  await assert.rejects(
    crossing(() => Promise.reject(cancelled)),
    (error: unknown) => error === cancelled,
  );
});

test("a call that succeeds returns its value", async () => {
  assert.equal(await crossing(async () => 7), 7);
});
