// Not in the Python suite: asyncio's own shield had no tests there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellable, Event } from "../../../src/core/sessions/tasks.ts";

test("a wait that gives up leaves the promise it waited for running", async () => {
  const done = new Event();
  const work = done.wait().then(() => "finished");
  const giving = new AbortController();
  const waiting = cancellable(work, giving.signal);
  giving.abort(new Error("gave up"));
  await assert.rejects(waiting, /gave up/);
  done.set();
  assert.equal(await work, "finished");
});

test("a wait whose signal had already aborted rejects with its reason and leaves no stray rejection", async (t) => {
  // The promise fails after its waiter has gone: nobody else handles it here, so without the
  // wait's own handler the process would report an unhandled rejection.
  const stray: unknown[] = [];
  const note = (reason: unknown) => stray.push(reason);
  process.on("unhandledRejection", note);
  t.after(() => process.off("unhandledRejection", note));
  const gone = new AbortController();
  gone.abort(new Error("gave up"));
  await assert.rejects(cancellable(Promise.reject(new Error("its own")), gone.signal), /gave up/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stray, []);
});

test("a wait with no signal is the promise itself", async () => {
  const work = Promise.resolve("finished");
  assert.equal(cancellable(work), work);
});
