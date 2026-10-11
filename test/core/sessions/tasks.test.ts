// Not in the Python suite: asyncio's own shield and its tasks had no tests there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellable, Event, Task } from "../../../src/core/sessions/tasks.ts";
import { setWriter } from "../../../src/log.ts";

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

/** The log lines written while `work` runs and the event loop turns twice after it. */
async function logged(work: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const restore = setWriter((line) => lines.push(line));
  try {
    await work();
    for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  } finally {
    setWriter(restore);
  }
  return lines;
}

test("a task that fails with nobody asking for its result is logged by name and place, not words", async () => {
  // asyncio wrote `Task exception was never retrieved`; a promise nobody awaits fails in silence.
  for (const immediate of [false, true]) {
    const lines = await logged(async () => {
      const task = new Task(
        async () => {
          throw new TypeError("the words of the failure");
        },
        { immediate },
      );
      await task.settled();
    });
    assert.equal(lines.length, 1, String(immediate));
    assert.match(
      lines[0] as string,
      / ERROR awaydesk\.core\.sessions\.tasks: a task failed: TypeError \(at /,
    );
    assert.doesNotMatch(lines[0] as string, /the words of the failure/);
  }
});

test("a task whose result was asked for, and a task that was cancelled, are not logged", async () => {
  const lines = await logged(async () => {
    const asked = new Task(async () => {
      throw new Error("its own");
    });
    await assert.rejects(asked.result(), /its own/);
    const waiting = new Event();
    const cancelled = new Task((signal) => waiting.wait(signal));
    await new Promise((resolve) => setImmediate(resolve));
    cancelled.cancel();
    await cancelled.settled();
  });
  assert.deepEqual(lines, []);
});

test("a task made to start at once has started when it is made, and another on the next turn", async () => {
  const order: string[] = [];
  const now = new Task(
    async () => {
      order.push("at once");
    },
    { immediate: true },
  );
  const later = new Task(async () => {
    order.push("next turn");
  });
  order.push("made");
  await Promise.all([now.settled(), later.settled()]);
  assert.deepEqual(order, ["at once", "made", "next turn"]);
});
