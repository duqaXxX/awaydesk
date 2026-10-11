/** Values nobody typed: a parsed value and a caught error, read by what they are. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { errorCode, errorName, isRecord, records } from "../src/values.ts";

test("a record is an object that is no list and not null", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ type: "user" }), true);
  for (const value of [null, undefined, [], [{}], "text", 7, true]) {
    assert.equal(isRecord(value), false, JSON.stringify(value));
  }
});

test("the records of a list are its objects, in order", () => {
  assert.deepEqual(records([{ a: 1 }, "text", null, [{ b: 2 }], { c: 3 }]), [{ a: 1 }, { c: 3 }]);
  for (const value of [null, undefined, "list", { a: 1 }]) assert.deepEqual(records(value), []);
});

test("a system error is named by its code and any other error by its name", () => {
  const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });
  assert.equal(errorCode(missing), "ENOENT");
  assert.equal(errorName(missing), "ENOENT");
  assert.equal(errorCode(new TypeError("bad")), undefined);
  assert.equal(errorName(new TypeError("bad")), "TypeError");
  // A code that is no string is no code, and what is no error has no name but its type.
  assert.equal(errorCode(Object.assign(new Error("odd"), { code: 7 })), undefined);
  assert.equal(errorCode({ code: "ENOENT" }), undefined);
  assert.equal(errorName("text"), "string");
  assert.equal(errorName(null), "object");
});

test("an error with no code is named by the name it gives itself, never by its class", () => {
  // A class of a bundled library is a minified name (`Kn` for the Agent SDK's abort, SDK
  // 0.3.296): it would reach a reply to the owner and change with each release.
  class Kn extends Error {}
  class Named extends Error {
    override name = "channel_not_found";
  }
  assert.equal(errorName(new Kn("words")), "Error");
  assert.equal(errorName(new Named("words")), "channel_not_found");
  assert.equal(errorName(new Error("words")), "Error");
  // The code comes first: it is what tells one system failure from another. An empty one is none.
  assert.equal(errorName(Object.assign(new Kn("words"), { code: "EACCES" })), "EACCES");
  assert.equal(errorName(Object.assign(new Named("words"), { code: "" })), "channel_not_found");
});
