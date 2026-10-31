/**
 * Dev/production parity for the JS minifier: dev builds ship scripts as
 * written and production builds ship `minifyJs` output, so both must run the
 * same program. Every case runs the source and the minified text and compares
 * what they did, not only the minified bytes.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { minifyJs } from "./js-minifier.ts";

type Run = { syntaxError?: string; threw?: string; log: unknown[] };

const run = (code: string): Run => {
  const log: unknown[] = [];
  let fn: (log: unknown[]) => unknown;
  try {
    fn = new Function("log", code) as (log: unknown[]) => unknown;
  } catch (error) {
    return { syntaxError: (error as Error).message, log };
  }
  try {
    fn(log);
  } catch (error) {
    return { threw: (error as Error).constructor.name, log };
  }
  return { log };
};

const expectSameProgram = (source: string): string => {
  const minified = minifyJs(source);
  const dev = run(source);
  expect(dev.syntaxError, `source must be valid: ${source}`).toBeUndefined();
  const prod = run(minified);
  expect(prod.syntaxError, `minified: ${minified}`).toBeUndefined();
  expect(prod, `minified: ${minified}`).toEqual(dev);
  return minified;
};

describe("minifyJs – postfix update before division (F035)", () => {
  it("treats `/` after a postfix ++ as division so a trailing // comment stays a comment", () => {
    const source = [
      "let count = 4, calls = 0; const update = () => calls++",
      "const half = count++ / 2 // halve it, see docs/notes",
      "update(half)",
      "log.push(half, count, calls)",
    ].join("\n");
    const minified = expectSameProgram(source);
    expect(minified).not.toContain("//");
    expect(minified).toContain("update(half)");
  });

  it.each([
    "let a = 9, b = 3; const c = a-- / b // ratio, see a/b\nlog.push(c, a)",
    "let a = 8, b = 2, c = 2; log.push(a-- / b / c)",
    'let i = 1; const q = i++ / 2; const url = "/api/x"; log.push(q, url)',
    "let i = 1; const q = i++ / 2 /* half/2 */\nlog.push(q)",
    "const o = { n: 6 }; const r = o.n++ / 3 // c/d\nlog.push(r, o.n)",
    "const arr = [6]; const r = arr[0]-- / 3 // c/d\nlog.push(r, arr[0])",
  ])("keeps division after a postfix update: %j", (source) => {
    expectSameProgram(source);
  });

  it("still reads a regex after a prefix update", () => {
    expectSameProgram("let i = 0; const r = [++i, /x/g.flags]\nlog.push(r)");
  });
});

describe("minifyJs – statement starting with a string or regex literal (F036)", () => {
  it.each([
    "const init = () => log.push('init')\nconst fn = () => {}\n/^\\/api/.test('/api/x') && init()",
    'const a = 1\n"use strict"\nlog.push(a)',
    'const a = 1\n"x".trim()\nlog.push(a)',
    'let f = () => 2\nlet a = f()\n"x"\nlog.push(a)',
    'let x = [1]\n"y"\nlog.push(x)',
    'const s = "a"\n"b".trim()\nlog.push(s)',
    "const s = 'a'\n'b'\nlog.push(s)",
    "const s = `a`\n'b'\nlog.push(s)",
    'const r = /x/g\n"b"\nlog.push(r.source)',
    "let i = 1; i++\n'x'\nlog.push(i)",
    'let o = { a: 1 }\n"b"\nlog.push(o.a)',
    'function f() {}\n"x"\nlog.push(typeof f)',
    'const o = { k: 1 }; o.k\n"x"\nlog.push(o.k)',
    "const fn = () => {}\n`t`\nlog.push(typeof fn)",
  ])("ends the statement before the literal: %j", (source) => {
    expectSameProgram(source);
  });

  it.each([
    // A template after a value is a tagged template in the source; joining keeps it one.
    "const tag = (s) => s[0] + '!'\nconst v = tag\n`hi`\nlog.push(v)",
    // An expression keyword before the literal still takes it as its operand.
    "log.push(typeof\n'x')",
    "const o = { a: 1 }; log.push('a' in\no)",
    "switch ('x') { case\n'x': log.push('hit') }",
    "if (true)\n'x'.length && log.push('body')",
    "if (false) {} else\n'x'.length && log.push('else')",
    // `return` is a restricted production: the newline ends the statement.
    "log.push((() => { return\n'x' })())",
    "log.push((() => { return\n/x/ })())",
    // A division after an object literal stays a division.
    "const re = 2, g = 1; const x = {}\n/re/g\nlog.push(Number.isNaN(x))",
    "function f() {}\n/[\"']  y/.test(\"'  y\") && log.push('regex')",
  ])("keeps the literal attached where the source does: %j", (source) => {
    expectSameProgram(source);
  });

  it("keeps a module `import` attached to its specifier on the next line", () => {
    expect(minifyJs('import\n"./side-effect.js"')).toBe(
      'import"./side-effect.js"',
    );
    expect(minifyJs('import { a } from\n"./a.js"')).toBe(
      'import{a}from"./a.js"',
    );
  });
});

describe("minifyJs – regex after else", () => {
  it("keeps the regex body, quotes and spaces included", () => {
    expectSameProgram(
      [
        'const s = "a x \'b"',
        "if (!s) log.push(0)",
        "else / x '/.test(s) && log.push(1)",
      ].join("\n"),
    );
  });
});

describe("minifyJs – lines starting with ( or [ continue the expression (F037)", () => {
  it.each([
    'const getEl = () => (f) => (log.push("called"), 1)\nconst el = getEl("x")\n(async () => { log.push("iife") })\nlog.push(el)',
    "const b = { 0: [5, 6] }; const c = 1, d = 0\nconst a = b\n[c, d].forEach((v) => log.push(v))",
    'const b = (k) => (log.push("b called"), 1)\nconst a = b\n(2)\nlog.push(a)',
    "const fns = [() => 7]\nconst r = fns[0]\n()\nlog.push(r)",
    "const f = () => () => 3\nconst r = f()\n()\nlog.push(r)",
    "const s = 'ab'\n[1]\nlog.push(s)",
    "const tpl = `ab`\n[0]\nlog.push(tpl)",
    // `}` of an expression continues; `}` of an arrow body or a block does not.
    "const g = function () { return 4 }\n(1)\nlog.push(g)",
    "const o = { k: 9 }\n['k']\nlog.push(o)",
    "const fn = () => {}\n;[1, 2].forEach((v) => log.push(v))",
    "const fn = () => {}\n(() => log.push('iife'))()",
    "const fn = () => { log.push('body') }\n[1, 2].forEach((v) => log.push(v))",
    "function f() {}\n(() => log.push('iife'))()",
    "if (true) { log.push('block') }\n[1, 2].forEach((v) => log.push(v))",
    // Restricted productions end the statement at the newline.
    "log.push((() => { return\n(1) })())",
    "for (const x of [1, 2]) { if (x) continue\n[x].forEach((v) => log.push(v)) }",
    "outer: for (const x of [1]) { for (const y of [2]) { if (y) continue outer\n(log.push('never')) } }\nlog.push('done')",
    "function* g() { yield\n(1) }\nlog.push([...g()])",
    // A postfix update cannot be called or indexed, so ASI ends the statement.
    "let i = 1; i++\n(() => log.push(i))()",
    "let i = 1; i--\n[1].forEach((v) => log.push(v, i))",
  ])("runs the same program as the source: %j", (source) => {
    expectSameProgram(source);
  });

  it("joins a keyword with its parenthesized header on the next line", () => {
    expect(minifyJs("if\n(a) b()")).toBe("if(a)b()");
    expect(minifyJs("while\n(a) b()")).toBe("while(a)b()");
    expect(minifyJs("typeof\n(a)")).toBe("typeof(a)");
  });
});

describe("minifyJs – semicolon-free statement sequences (property)", () => {
  // Statements a hand-written, semicolon-free script might contain, including the ones whose
  // line breaks ASI does or does not turn into statement ends.
  const statement = fc.constantFrom(
    "n++",
    "n--",
    "log.push(n)",
    "o.k = n",
    "arr[0] = n",
    "const f = () => {}",
    "const g = () => { log.push('g') }",
    "function h() {}",
    "if (n) { log.push('if') }",
    "x = { k: 1 }",
    "x = n++ / 2 // half, see a/b",
    "'use strict'",
    '"text".trim()',
    "`t`.length",
    "/^\\/api/.test('/api') && log.push('re')",
    "(() => log.push('iife'))()",
    "[1, 2].forEach((v) => log.push(v))",
    "(n)",
    "[n]",
    "x = arr\n[0]",
  );

  it("runs the same program minified as unminified", () => {
    fc.assert(
      fc.property(
        fc.array(statement, { minLength: 1, maxLength: 6 }),
        (lines) => {
          const source = `let n = 1, x, o = {}, arr = [0]\n${lines.join("\n")}\nlog.push(n, x)`;
          const dev = run(source);
          // Some sequences are invalid or throw as written (`f\n(n)` calls the arrow); parity
          // still holds for those, so only an invalid source is skipped.
          fc.pre(dev.syntaxError === undefined);
          const prod = run(minifyJs(source));
          expect(prod, minifyJs(source)).toEqual(dev);
        },
      ),
      { numRuns: 500 },
    );
  });
});
