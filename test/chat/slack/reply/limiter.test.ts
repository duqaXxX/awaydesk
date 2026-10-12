/**
 * The shared budget of updates on a fake clock: what it lets through at once, how it paces the
 * rest, and the line it logs when a write waited long (issue #203).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UPDATE_BURST,
  UPDATE_LIMIT,
  UPDATE_WAIT_LOGGED_SECONDS,
  UPDATE_WINDOW_SECONDS,
  UpdateLimiter,
} from "../../../../src/chat/slack/reply/limiter.ts";
import { FakeClock } from "../../../support/fake-clock.ts";

const STEP = UPDATE_WINDOW_SECONDS / UPDATE_LIMIT;

function limiterOn(clock: FakeClock): { limiter: UpdateLimiter; lines: string[] } {
  const lines: string[] = [];
  const limiter = new UpdateLimiter({ clock, logger: { info: (line) => lines.push(line) } });
  return { limiter, lines };
}

test("the burst passes at once and logs nothing", async () => {
  const { limiter, lines } = limiterOn(new FakeClock());
  for (let i = 0; i < UPDATE_BURST; i += 1) await limiter.acquire();
  assert.deepEqual(lines, []);
});

test("a write that waits one token is not logged", async () => {
  const clock = new FakeClock();
  const { limiter, lines } = limiterOn(clock);
  for (let i = 0; i < UPDATE_BURST; i += 1) await limiter.acquire();
  const next = limiter.acquire();
  await clock.advance(STEP);
  await next;
  assert.deepEqual(lines, []);
});

test("a write behind a line of others is logged with how long it waited", async () => {
  const clock = new FakeClock();
  const { limiter, lines } = limiterOn(clock);
  for (let i = 0; i < UPDATE_BURST; i += 1) await limiter.acquire();
  // Enough callers that the last one waits past the threshold, each a token apart.
  const waiting = Math.ceil(UPDATE_WAIT_LOGGED_SECONDS / STEP) + 1;
  const queued = Array.from({ length: waiting }, () => limiter.acquire());
  for (let i = 0; i < waiting; i += 1) await clock.advance(STEP);
  await Promise.all(queued);
  assert.ok(lines.length >= 1);
  assert.match(lines.at(-1) ?? "", /^a write waited \d+\.\d s for the shared budget of updates$/);
  // The first callers in line waited less than the threshold.
  assert.ok(lines.length < waiting);
});
