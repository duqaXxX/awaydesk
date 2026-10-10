/** Reading a wire value as `unknown`: each helper gives the value in its type, or null. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { integer, number, records, string, words } from "../../../src/agent/claude/wire.ts";

test("a string is read as a string and anything else as none", () => {
  assert.equal(string("ok"), "ok");
  assert.equal(string(""), "");
  for (const value of [null, undefined, 7, true, {}, ["ok"]]) assert.equal(string(value), null);
});

test("words are a string that says something", () => {
  assert.equal(words("ok"), "ok");
  assert.equal(words(" "), " ");
  for (const value of ["", null, undefined, 7, {}]) assert.equal(words(value), null);
});

test("a whole number is read as one and a fraction as none", () => {
  assert.equal(integer(20742), 20742);
  assert.equal(integer(0), 0);
  for (const value of [3.5, "3", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, true]) {
    assert.equal(integer(value), null);
  }
});

test("a number is read as one, a fraction included", () => {
  assert.equal(number(4886), 4886);
  assert.equal(number(0.5), 0.5);
  for (const value of ["4886", null, undefined, Number.NaN, Number.POSITIVE_INFINITY, false]) {
    assert.equal(number(value), null);
  }
});

test("the records of a list are its objects, in order", () => {
  assert.deepEqual(records([{ a: 1 }, "text", null, [{ b: 2 }], { c: 3 }]), [{ a: 1 }, { c: 3 }]);
  for (const value of [null, undefined, "list", { a: 1 }]) assert.deepEqual(records(value), []);
});
