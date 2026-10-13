import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Placed, positionOf, ThreadOrder } from "../../../../src/chat/slack/reply/order.ts";

function reply(ts: string | null): Placed & { lastAt: number | null } {
  return { lastAt: ts === null ? null : positionOf(ts) };
}

describe("positionOf", () => {
  test("is the ts as an integer of microseconds", () => {
    assert.equal(positionOf("1760000000.123456"), 1760000000123456);
    assert.equal(positionOf("1760000000.5"), 1760000000500000);
    assert.ok(Number.isSafeInteger(positionOf("1760000000.999999")));
  });

  test("orders as the thread does", () => {
    assert.ok(positionOf("1760000000.000009") < positionOf("1760000000.000010"));
    assert.ok(positionOf("1760000000.999999") < positionOf("1760000001.000000"));
  });
});

describe("ThreadOrder", () => {
  test("a reply with no message is neither last nor overtaken", () => {
    const order = new ThreadOrder();
    const bare = reply(null);
    order.moved(bare);
    assert.equal(order.last(bare), false);
    assert.equal(order.overtaken(bare), false);
  });

  test("a reply is last when nothing sits below it, and overtaken by another reply", () => {
    const order = new ThreadOrder();
    const first = reply("1760000001.000001");
    order.moved(first);
    assert.equal(order.last(first), true);
    const second = reply("1760000002.000001");
    order.moved(second);
    assert.equal(order.last(first), false);
    assert.equal(order.overtaken(first), true);
    assert.equal(order.last(second), true);
    assert.equal(order.overtaken(second), false);
  });

  test("an owner message below a reply makes it not last, and not overtaken", () => {
    const order = new ThreadOrder();
    const first = reply("1760000001.000001");
    order.moved(first);
    order.ownerPosted("1760000002.000001");
    assert.equal(order.last(first), false);
    assert.equal(order.overtaken(first), false);
  });

  test("an owner message above a reply leaves it last", () => {
    const order = new ThreadOrder();
    const first = reply("1760000003.000001");
    order.moved(first);
    order.ownerPosted("1760000002.000001");
    assert.equal(order.last(first), true);
  });

  test("an ended reply sealed by an owner mark is dropped, and the order with it", () => {
    const presence: boolean[] = [];
    const order = new ThreadOrder((present) => presence.push(present));
    const first = reply("1760000001.000001");
    order.moved(first);
    order.ownerPosted("1760000002.000001");
    order.ended(first);
    assert.deepEqual(presence, [true, false]);
    // Another reply that moves in later finds nothing of the dropped one.
    const second = reply("1760000000.500000");
    order.moved(second);
    assert.equal(order.overtaken(second), false);
    assert.deepEqual(presence, [true, false, true]);
  });

  test("an ended reply with no owner mark below it stays", () => {
    const order = new ThreadOrder();
    const first = reply("1760000001.000001");
    const second = reply("1760000002.000001");
    order.moved(first);
    order.moved(second);
    order.ended(second);
    assert.equal(order.overtaken(first), true);
  });
});
