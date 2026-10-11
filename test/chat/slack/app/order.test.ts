/**
 * `ThreadOrder`: the places of one thread are taken in the order `enter` is called and left one
 * at a time; two threads never wait for each other; nothing is kept for a thread whose last
 * place was left.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ThreadOrder } from "../../../../src/chat/slack/app/order.ts";

/** Lets every promise callback that is ready run. */
const flush = () => new Promise<void>((done) => setImmediate(done));

test("a place waits for the places entered before it, in the order they were entered", async () => {
  const order = new ThreadOrder();
  const seen: string[] = [];
  const first = order.enter("a");
  const second = order.enter("a");
  const third = order.enter("a");
  void second.turn.then(() => seen.push("second"));
  void third.turn.then(() => seen.push("third"));
  await first.turn;
  await flush();
  assert.deepEqual(seen, []); // the first is still held
  first.leave();
  await flush();
  assert.deepEqual(seen, ["second"]);
  second.leave();
  await flush();
  assert.deepEqual(seen, ["second", "third"]);
  third.leave();
});

test("the place after a left one is free at once, whoever left it", async () => {
  const order = new ThreadOrder();
  const first = order.enter("a");
  const second = order.enter("a");
  first.leave();
  first.leave(); // leaving twice is the same as once
  await second.turn;
  second.leave();
});

test("two threads do not wait for each other", async () => {
  const order = new ThreadOrder();
  order.enter("a"); // never left
  const other = order.enter("b");
  await other.turn;
  other.leave();
});

test("nothing is kept for a thread once its last place is left", async () => {
  const order = new ThreadOrder();
  const first = order.enter("a");
  const second = order.enter("a");
  assert.equal(order.size, 1);
  first.leave();
  assert.equal(order.size, 1); // the second still holds the thread
  await second.turn;
  second.leave();
  assert.equal(order.size, 0);
  order.enter("b").leave();
  assert.equal(order.size, 0);
});
