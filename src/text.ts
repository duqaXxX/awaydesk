/**
 * Strings the way Python's `str` treats them, where JavaScript's `String` differs: what counts
 * as whitespace, and the order of two strings, and the quoting of a word for a shell. The texts the daemon cuts and sorts come out as
 * Python cut and sorted them, and the goldens hold those results. Any layer imports this.
 */

// What Python's `str.split()`, `str.strip()` and `\s` take for whitespace (`str.isspace`), as
// ranges of code points: JavaScript's `\s` lacks U+001C to U+001F and U+0085, and adds U+FEFF.
const SPACE_RANGES: readonly (readonly [number, number])[] = [
  [0x09, 0x0d],
  [0x1c, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

/** The UTF-16 unit `code` as it is written in a pattern built from codes. */
export function escaped(code: number): string {
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/** The body of a regular expression class that matches Python's whitespace: `[${PY_SPACE}]`. */
export const PY_SPACE = SPACE_RANGES.map(([first, last]) =>
  first === last ? escaped(first) : `${escaped(first)}-${escaped(last)}`,
).join("");

/** Whether the UTF-16 unit `code` is whitespace to Python: every such character is one unit. */
export function isSpace(code: number): boolean {
  return SPACE_RANGES.some(([first, last]) => code >= first && code <= last);
}

/**
 * Python's `text.strip()`. Read by code from each end: a pattern that ends on `$` would start
 * again from every run of spaces, which is quadratic on a long text.
 */
export function strip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** Whether `text` holds nothing but whitespace: Python's `not text.strip()`. */
export function blank(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (!isSpace(text.charCodeAt(i))) return false;
  }
  return true;
}

/** Python's `sorted` on strings: by code point, where `Array.prototype.sort` goes by UTF-16 unit. */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i] as string;
    const y = right[i] as string;
    if (x !== y) return (x.codePointAt(0) as number) - (y.codePointAt(0) as number);
  }
  return left.length - right.length;
}

/** Whether the UTF-16 unit `code` opens a surrogate pair. */
export function isHigh(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Whether the UTF-16 unit `code` closes a surrogate pair. */
export function isLow(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Python's `len(text)`: the code points of a text. */
export function len(text: string): number {
  let count = text.length;
  for (let i = 0; i < text.length - 1; i += 1) {
    if (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1))) {
      count -= 1;
      i += 1;
    }
  }
  return count;
}

/** `shlex.quote`: the word as one shell argument, quoted only when it needs to be. */
export function shellQuote(word: string): string {
  if (word === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\"'\"'")}'`;
}
