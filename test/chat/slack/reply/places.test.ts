import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type Placed, positionOf, ThreadPlaces } from "../../../../src/chat/slack/reply/places.ts";

interface Reply extends Placed {
  lastAt: number | null;
}

function reply(ts: string | null): Reply {
  return { lastAt: ts === null ? null : positionOf(ts) };
}

function joined(places: ThreadPlaces, ts: string | null): Reply {
  const made = reply(ts);
  places.join(made);
  return made;
}

describe("positionOf", () => {
  test("is the ts as an integer of microseconds", () => {
    assert.equal(positionOf("1760000000.123456"), 1760000000123456);
    assert.equal(positionOf("1760000000.5"), 1760000000500000);
  });

  test("orders as the thread does", () => {
    assert.ok((positionOf("1760000000.000009") ?? 0) < (positionOf("1760000000.000010") ?? 0));
    assert.ok((positionOf("1760000000.999999") ?? 0) < (positionOf("1760000001.000000") ?? 0));
  });

  test("is null for text that is no ts", () => {
    for (const bad of ["", "abc", "1.2.3", "NaN", "Infinity", "-1.5", "1e9.5"]) {
      assert.equal(positionOf(bad), null, bad);
    }
  });
});

describe("ThreadPlaces", () => {
  test("a reply with no message is neither last nor overtaken", () => {
    const places = new ThreadPlaces();
    const bare = joined(places, null);
    assert.equal(places.last(bare), false);
    assert.equal(places.overtaken(bare), false);
  });

  test("a reply the places do not hold is not last", () => {
    const places = new ThreadPlaces();
    assert.equal(places.last(reply("1760000001.000001")), false);
  });

  test("a reply is last until another reply or the owner writes below it", () => {
    const places = new ThreadPlaces();
    const first = joined(places, "1760000001.000001");
    assert.equal(places.last(first), true);
    const second = joined(places, "1760000002.000001");
    assert.equal(places.last(first), false);
    assert.equal(places.overtaken(first), true);
    assert.equal(places.last(second), true);
    places.ownerPosted("1760000003.000001");
    assert.equal(places.last(second), false);
    assert.equal(places.overtaken(second), false);
  });

  test("an owner message that arrives before a reply has a message counts by its position", () => {
    const below = new ThreadPlaces();
    const early = joined(below, null);
    below.ownerPosted("1760000002.000001");
    early.lastAt = positionOf("1760000001.000001");
    below.moved(early);
    assert.equal(below.last(early), false, "the mark is below the message");
    const above = new ThreadPlaces();
    const late = joined(above, null);
    above.ownerPosted("1760000001.000001");
    late.lastAt = positionOf("1760000002.000001");
    above.moved(late);
    assert.equal(above.last(late), true, "the mark is above the message");
  });

  test("a ts that is no position is ignored", () => {
    const places = new ThreadPlaces();
    const first = joined(places, "1760000001.000001");
    places.ownerPosted("garbage");
    assert.equal(places.last(first), true);
  });

  test("the answers do not change when an ended reply is let go of", () => {
    const places = new ThreadPlaces();
    const older = joined(places, "1760000001.000001");
    const newer = joined(places, "1760000002.000001");
    places.ended(newer);
    places.ownerPosted("1760000003.000001");
    assert.equal(places.last(newer), false, "let go of");
    assert.equal(places.overtaken(older), true, "its position still sits below the older reply");
    assert.equal(places.last(older), false);
  });

  test("an ended reply with no owner message below it is kept", () => {
    const places = new ThreadPlaces();
    const first = joined(places, "1760000001.000001");
    const second = joined(places, "1760000002.000001");
    places.ended(second);
    assert.equal(places.overtaken(first), true);
    assert.equal(places.last(second), true);
  });

  test("a reply is let go of when its opening thread closed and its end landed, in either order", () => {
    const left: number[] = [];
    const places = new ThreadPlaces(() => left.push(1));
    const first = joined(places, "1760000001.000001");
    places.closed(first);
    assert.equal(places.held, true, "not ended yet");
    places.ended(first);
    assert.equal(places.held, false);
    const second = joined(places, "1760000002.000001");
    places.ended(second);
    assert.equal(places.held, true, "its thread is open");
    places.closed(second);
    assert.equal(places.held, false);
    assert.deepEqual(left, [1, 1]);
  });
});
