import assert from "node:assert/strict";
import { test } from "node:test";
import { TIMED_OUT, within } from "../../../../src/chat/slack/openfile/waiting.ts";
import { AsyncEvent, FakeClock } from "../../../support/fake-slack.ts";

test("a time limit ends the work's wait when the clock passes it", async () => {
  const clock = new FakeClock();
  let sawAbort = false;
  const pending = within(clock, 5, (signal) => {
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
        reject(signal.reason);
      });
    });
  });
  await clock.advance(4);
  assert.ok(!sawAbort);
  await clock.advance(1);
  assert.equal(await pending, TIMED_OUT);
  assert.ok(sawAbort);
});

test("work that ends in time is returned and the clock's sleep is dropped", async () => {
  const clock = new FakeClock();
  assert.equal(await within(clock, 5, async () => "done"), "done");
  await clock.advance(10); // nothing left to wake
});

test("work that ignores its signal is still given up on at the limit", async () => {
  const clock = new FakeClock();
  const never = new AsyncEvent();
  const pending = within(clock, 1, () => never.wait().then(() => "late"));
  await clock.advance(1);
  assert.equal(await pending, TIMED_OUT);
  never.set();
});

test("an out of time limit is out of time at once and the work is not started", async () => {
  let started = false;
  assert.equal(
    await within(new FakeClock(), 0, async () => {
      started = true;
    }),
    TIMED_OUT,
  );
  assert.ok(!started);
});

test("work that fails for its own reason is not taken for a timeout", async () => {
  await assert.rejects(
    within(new FakeClock(), 5, async () => {
      throw new Error("its own");
    }),
    /its own/,
  );
});
