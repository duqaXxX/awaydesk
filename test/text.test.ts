/** Strings as Python treated them: its whitespace and its order, where JavaScript's differ. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCodePoints, isSpace, PY_SPACE, strip } from "../src/text.ts";

// Every character `str.isspace()` holds true for (CPython 3.12), and no other.
const PYTHON_SPACES = [
  0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
];

test("a text is cut of the white space at its ends as Python cuts it", () => {
  assert.equal(strip("  ok \n\t"), "ok");
  assert.equal(strip("a  b"), "a  b");
  assert.equal(strip(""), "");
  assert.equal(strip(" \n "), "");
  for (const code of PYTHON_SPACES) {
    const space = String.fromCodePoint(code);
    assert.equal(strip(`${space}ok${space}`), "ok", code.toString(16));
  }
  // White space to JavaScript's `trim` and not to Python.
  assert.equal(strip("﻿ok﻿"), "﻿ok﻿");
  // White space to neither.
  assert.equal(strip("​ok​"), "​ok​");
});

test("the pattern and the test by code hold the same whitespace", () => {
  // One set, two readings of it: a pattern for the callers that split, a test for `strip`.
  const pattern = new RegExp(`^[${PY_SPACE}]$`);
  const spaces = new Set(PYTHON_SPACES);
  for (let code = 0; code <= 0xffff; code += 1) {
    assert.equal(isSpace(code), spaces.has(code), code.toString(16));
    assert.equal(pattern.test(String.fromCharCode(code)), spaces.has(code), code.toString(16));
  }
});

test("strings sort by code point where an array sort goes by UTF-16 unit", () => {
  const astral = "\u{1F600}"; // two units starting at D83D, before U+FFFD in UTF-16
  const bmp = "�";
  assert.ok(astral < bmp); // UTF-16 order puts the astral character first...
  assert.ok(compareCodePoints(astral, bmp) > 0); // ...and code point order puts it last
  assert.deepEqual([astral, bmp, "a", "B"].toSorted(compareCodePoints), ["B", "a", bmp, astral]);
  assert.equal(compareCodePoints("a", "ab"), -1);
  assert.equal(compareCodePoints("ab", "ab"), 0);
});
