import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type Placed,
  positionOf,
  type Shown,
  ThreadPlaces,
} from "../../../../src/chat/slack/reply/places.ts";

interface Reply extends Placed {
  lastAt: number | null;
  resting: boolean;
  ownFooter: string | null;
  /** The tails handed to it, in order. */
  assigned: Shown[];
  /** How many times it was told to settle. */
  settled: number;
}

function reply(ts: string | null, ownFooter: string | null = null): Reply {
  const made: Reply = {
    lastAt: ts === null ? null : positionOf(ts),
    resting: false,
    ownFooter,
    assigned: [],
    assign: (shown) => made.assigned.push(shown),
    settled: 0,
    settle: async () => {
      made.settled += 1;
      return true;
    },
  };
  return made;
}

/** The footer a reply was last handed. */
function footerOf(reply: Reply): string | null {
  return reply.assigned.at(-1)?.footer ?? null;
}

function joined(places: ThreadPlaces, ts: string | null, footer: string | null = null): Reply {
  const made = reply(ts, footer);
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

  test("a reply let go of is still overtaken by one that wrote below it", () => {
    const places = new ThreadPlaces();
    const first = joined(places, "1760000001.000001");
    places.ended(first);
    places.ownerPosted("1760000002.000001"); // lets it go
    assert.equal(places.holds(first), false);
    joined(places, "1760000003.000001");
    assert.equal(places.overtaken(first), true);
    assert.equal(places.last(first), false);
  });

  test("an ended reply with no owner message below it is kept", () => {
    const places = new ThreadPlaces();
    const first = joined(places, "1760000001.000001");
    const second = joined(places, "1760000002.000001");
    places.ended(second);
    assert.equal(places.overtaken(first), true);
    assert.equal(places.last(second), true);
  });

  test("a reply is let go of when its opening thread closes, its end landed or not", () => {
    const left: number[] = [];
    const places = new ThreadPlaces(() => left.push(1));
    const first = joined(places, "1760000001.000001");
    places.closed(first);
    assert.equal(places.held, false, "its end never landed, and its session is gone");
    const second = joined(places, "1760000002.000001");
    places.ended(second);
    assert.equal(places.held, true, "its thread is open");
    places.closed(second);
    assert.equal(places.held, false);
    assert.deepEqual(left, [1, 1]);
  });

  test("the lowest resting reply of a stretch is handed the footer, and the others none", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001", "upper");
    const lower = joined(places, "1760000002.000001", "lower");
    upper.resting = true;
    places.ended(upper);
    assert.equal(footerOf(upper), "upper");
    lower.resting = true;
    places.ended(lower);
    assert.equal(footerOf(upper), null);
    assert.equal(footerOf(lower), "lower");
  });

  test("an owner message cuts the thread into stretches of one footer each", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001", "upper");
    places.ownerPosted("1760000002.000001");
    const lower = joined(places, "1760000003.000001", "lower");
    upper.resting = true;
    lower.resting = true;
    places.ended(upper);
    places.ended(lower);
    assert.equal(footerOf(lower), "lower");
    assert.equal(places.holds(upper), false, "let go of, with the footer it was handed");
    assert.equal(footerOf(upper), "upper");
  });

  test("an ended reply stays while a reply above the next owner message is still to end", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001", "upper");
    const lower = joined(places, "1760000002.000001", "lower");
    upper.resting = true;
    places.ended(upper);
    places.ownerPosted("1760000003.000001");
    assert.equal(places.holds(upper), true, "the lower reply may still take its footer");
    lower.resting = true;
    places.ended(lower);
    assert.equal(footerOf(upper), null, "it was told before it was let go of");
    assert.equal(places.holds(upper), false);
    assert.equal(places.holds(lower), false);
  });

  test("a reply with no message yet does not keep an ended one", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001", "upper");
    joined(places, null);
    upper.resting = true;
    places.ended(upper);
    places.ownerPosted("1760000002.000001");
    assert.equal(places.holds(upper), false, "it will land below the owner message");
  });

  test("tailIf is the tail a reply would be handed if it rested now", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001", "upper");
    const lower = joined(places, "1760000002.000001", "lower");
    lower.resting = true;
    places.ended(lower);
    assert.equal(places.tailIf(upper).footer, null, "the lower one holds the stretch's footer");
    assert.equal(places.tailIf(lower).footer, "lower");
    const bare = joined(places, null, "bare");
    assert.equal(places.tailIf(bare).footer, "bare", "unplaced, it lands below everything");
  });

  test("a reply that moved is placed again", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001", "upper");
    const lower = joined(places, "1760000002.000001", "lower");
    upper.resting = true;
    lower.resting = true;
    places.ended(upper);
    places.ended(lower);
    upper.lastAt = positionOf("1760000003.000001"); // its ending was posted below the lower one
    places.moved(upper);
    assert.equal(footerOf(upper), "upper");
    assert.equal(footerOf(lower), null);
  });

  test("the list is handed to the lowest resting reply, and to no other", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001");
    const lower = joined(places, "1760000002.000001");
    const running = { title: "1 shell still running", lines: ["sleep"] };
    upper.resting = true;
    places.showRunning(running);
    assert.deepEqual(upper.assigned.at(-1)?.list, running);
    lower.resting = true;
    places.place();
    assert.equal(upper.assigned.at(-1)?.list, null);
    assert.deepEqual(lower.assigned.at(-1)?.list, running);
    places.showRunning(null);
    assert.equal(lower.assigned.at(-1)?.list, null);
  });

  test("the reply that holds the list is not let go of while it does", () => {
    const places = new ThreadPlaces();
    const reply = joined(places, "1760000001.000001");
    reply.resting = true;
    places.showRunning({ title: "1 shell still running", lines: ["sleep"] });
    places.ended(reply);
    places.ownerPosted("1760000002.000001");
    assert.equal(places.holds(reply), true, "the list could never be taken off a reply that went");
    places.showRunning(null);
    assert.equal(places.holds(reply), false, "and it goes once it holds nothing");
  });

  test("a reply that loses the list to one below is let go of then", () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001");
    upper.resting = true;
    places.showRunning({ title: "1 shell still running", lines: ["sleep"] });
    places.ended(upper);
    places.ownerPosted("1760000002.000001");
    const lower = joined(places, "1760000003.000001");
    lower.resting = true;
    places.ended(lower);
    assert.equal(places.holds(upper), false);
    assert.equal(places.holds(lower), true);
  });

  test("a closed thread lets go of the reply that holds the list", () => {
    const places = new ThreadPlaces();
    const reply = joined(places, "1760000001.000001");
    reply.resting = true;
    places.showRunning({ title: "1 shell still running", lines: ["sleep"] });
    places.ended(reply);
    places.closed(reply);
    assert.equal(places.holds(reply), false);
  });

  test("a reply let go of after it held the list is still settled by the close", async () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001");
    upper.resting = true;
    places.showRunning({ title: "1 shell still running", lines: ["sleep"] });
    places.ended(upper);
    places.ownerPosted("1760000002.000001");
    places.showRunning(null); // the holder is sealed, so it is let go of with its edit unwritten
    assert.equal(places.holds(upper), false);
    await places.settleListed();
    assert.equal(upper.settled, 1);
    await places.settleListed();
    assert.equal(upper.settled, 1, "once");
  });

  test("the reply the list moved down from is settled by the close, let go of or not", async () => {
    const places = new ThreadPlaces();
    const upper = joined(places, "1760000001.000001");
    upper.resting = true;
    places.showRunning({ title: "1 shell still running", lines: ["sleep"] });
    places.ended(upper);
    places.ownerPosted("1760000002.000001");
    const lower = joined(places, "1760000003.000001");
    lower.resting = true;
    places.ended(lower);
    await places.settleListed();
    assert.equal(upper.settled, 1);
    assert.equal(lower.settled, 1);
  });
});
