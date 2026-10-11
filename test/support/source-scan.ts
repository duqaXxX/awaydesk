/**
 * The sources read as text: the compiler API is not a dependency. `blank` leaves the code's own
 * shape, which the docs test reads declarations from and the vocabulary test reads words from.
 */

/**
 * `source` with comments blanked to spaces, and with them the insides of strings and of regular
 * expressions, unless `keepText` leaves those as written.
 */
export function blank(source: string, options: { readonly keepText?: boolean } = {}): string {
  const keepText = options.keepText ?? false;
  let out = "";
  let i = 0;
  const space = (ch: string): string => (ch === "\n" ? "\n" : " ");
  // What a character inside a string, a template or a regular expression becomes.
  const text = (ch: string): string => (keepText ? ch : space(ch));

  function quoted(quote: string): void {
    out += quote;
    i += 1;
    while (i < source.length && source.charAt(i) !== quote) {
      if (source.charAt(i) === "\\") {
        out += text(source.charAt(i));
        i += 1;
      }
      out += text(source.charAt(i));
      i += 1;
    }
    out += quote;
    i += 1;
  }

  function template(): void {
    out += "`";
    i += 1;
    while (i < source.length && source.charAt(i) !== "`") {
      if (source.charAt(i) === "\\") {
        out += text(source.charAt(i));
        i += 1;
        out += text(source.charAt(i));
        i += 1;
      } else if (source.charAt(i) === "$" && source.charAt(i + 1) === "{") {
        out += "${";
        i += 2;
        code(true);
      } else {
        out += text(source.charAt(i));
        i += 1;
      }
    }
    out += "`";
    i += 1;
  }

  function regex(): void {
    out += "/";
    i += 1;
    let inClass = false;
    while (i < source.length && (source.charAt(i) !== "/" || inClass)) {
      const ch = source.charAt(i);
      if (ch === "\\") {
        out += text(source.charAt(i));
        i += 1;
      } else if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      out += text(source.charAt(i));
      i += 1;
    }
    out += "/";
    i += 1;
  }

  // Code up to the end of the file, or, inside a template's `${`, up to its closing brace.
  function code(nested: boolean): void {
    let depth = 0;
    let last = "";
    while (i < source.length) {
      const ch = source.charAt(i);
      const after = source.charAt(i + 1);
      if (ch === "/" && after === "/") {
        while (i < source.length && source.charAt(i) !== "\n") {
          out += " ";
          i += 1;
        }
      } else if (ch === "/" && after === "*") {
        const end = source.indexOf("*/", i + 2);
        const stop = end < 0 ? source.length : end + 2;
        for (; i < stop; i += 1) out += space(source.charAt(i));
      } else if (ch === '"' || ch === "'") {
        quoted(ch);
        last = ch;
      } else if (ch === "`") {
        template();
        last = ch;
      } else if (
        ch === "/" &&
        (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || out.trimEnd().endsWith("return"))
      ) {
        regex();
        last = ")";
      } else {
        if (ch === "{") depth += 1;
        if (ch === "}") {
          if (nested && depth === 0) {
            out += "}";
            i += 1;
            return;
          }
          depth -= 1;
        }
        out += ch;
        i += 1;
        if (ch.trim() !== "") last = ch;
      }
    }
  }

  code(false);
  return out;
}
