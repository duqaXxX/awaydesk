// Not in the Python suite: asyncio's own shield, tasks, semaphore and lock had no tests there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellable, Event, Mutex, Semaphore, Task } from "../../../src/core/sessions/tasks.ts";
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

test("the words of a failure never pass for the place it was thrown", async () => {
  // A stack opens with the message, and a message may hold a line that reads like a frame.
  const lines = await logged(async () => {
    const task = new Task(async () => {
      throw new Error("could not read it:\n    at the words of the reply (not/a/place.ts:1:2)");
    });
    await task.settled();
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] as string, /the words of the reply/);
  assert.match(lines[0] as string, /a task failed: Error \(at .*tasks\.test\.ts:\d+:\d+\)$/);
  // A stack that is no string names no place, and breaks nothing.
  const odd = Object.assign(new Error("words"), { stack: 7 });
  const others = await logged(async () => {
    await new Task(async () => {
      throw odd;
    }).settled();
  });
  assert.deepEqual(
    others.map((line) => line.replace(/^.*: a task failed: /, "")),
    ["Error"],
  );
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

test("a semaphore lets its limit of holders in and the next one in when a place is given back", async () => {
  const gate = new Semaphore(2);
  const order: string[] = [];
  const hold = new Event();
  const job = (name: string) =>
    gate.run(async () => {
      order.push(`${name} in`);
      await hold.wait();
      order.push(`${name} out`);
    });
  const jobs = [job("a"), job("b"), job("c")];
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["a in", "b in"]);
  hold.set();
  await Promise.all(jobs);
  assert.deepEqual(order, ["a in", "b in", "a out", "b out", "c in", "c out"]);
});

test("a request that gives up while waiting for a turn leaves the queue", async () => {
  const gate = new Semaphore(1);
  const release = await gate.acquire();
  const giving = new AbortController();
  const waiting = gate.acquire(giving.signal);
  const behind = gate.acquire();
  giving.abort(new Error("gave up"));
  await assert.rejects(waiting, /gave up/);
  release();
  await behind; // the turn went to the one behind, not to the one that left
});

test("a place given back twice is given back once", async () => {
  // `Gate.release` counted every call: a second one let one holder too many in.
  const lock = new Mutex();
  const release = await lock.acquire();
  release();
  release();
  const first = await lock.acquire();
  let second = false;
  void lock.acquire().then(() => {
    second = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second, false);
  first();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second, true);
});
