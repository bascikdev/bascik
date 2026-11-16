/**
 * Dev/production parity for the JS minifier: dev builds ship scripts as
 * written and production builds ship `minifyJs` output, so both must run the
 * same program. Every case runs the source and the minified text and compares
 * what they did, not only the minified bytes.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { propertyBounds } from "./property-runs.test-helper.ts";
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

describe("minifyJs – operators that would join into another token", () => {
  // `+` and `+` are two operators, `++` is one; a line break or a comment kept them apart.
  it.each([
    [
      "a sign on the next line",
      "const a = 1, b = '2'\nconst x = a +\n  +b\nlog.push(x)",
    ],
    [
      "a negation on the next line",
      "const a = 1, b = 2\nconst x = a -\n  -b\nlog.push(x)",
    ],
    [
      "a prefix ++ on the next line",
      "let a = 1, b = 2\nconst x = a +\n  ++b\nlog.push(x, a, b)",
    ],
    [
      "a prefix -- on the next line",
      "let a = 1, b = 2\nconst x = a -\n  --b\nlog.push(x, a, b)",
    ],
    [
      "a sign after a blank line",
      "const a = 1, b = '2'\nconst x = a +\n\n  +b\nlog.push(x)",
    ],
    [
      "a sign after a line comment",
      "const a = 1, b = '2'\nconst x = a + // then the number\n  +b\nlog.push(x)",
    ],
    [
      "a sign after a block comment",
      "const a = 1, b = '2'\nconst x = a +/* sign */+ b\nlog.push(x)",
    ],
    [
      "a negation after a block comment",
      "const a = 1, b = 2\nconst x = a -/* sign */- b\nlog.push(x)",
    ],
    [
      "a prefix ++ after a block comment",
      "let a = 1, b = 2\nconst x = a +/* then */++b\nlog.push(x, a, b)",
    ],
    [
      "a string then a sign on the next line",
      "const b = '2'\nconst x = 'a' +\n  +b\nlog.push(x)",
    ],
    [
      "a sign then a string on the next line",
      "const a = 1\nconst x = a +\n  +'2'\nlog.push(x)",
    ],
    [
      "three plus signs over three lines",
      "const a = 1, b = '2'\nconst x = a +\n  +\n  +b\nlog.push(x)",
    ],
    [
      "a postfix ++ then a plus line",
      "let a = 1, b = 2\nconst x = a++\n  + b\nlog.push(x, a)",
    ],
  ])("keeps apart %s", (_name, source) => {
    expectSameProgram(source);
  });

  // `/` and then a regex literal must not become `//`, which comments out the rest.
  it.each([
    ["a number", "const x = 6 / /ab/.source.length\nlog.push(x)"],
    [
      "a name",
      "const a = 6\nconst x = a / /ab/.source.length / 3\nlog.push(x)",
    ],
    [
      "a name, regex on the next line",
      "const a = 6\nconst x = a /\n  /ab/.source.length\nlog.push(x)",
    ],
    [
      "a name, slash on the next line",
      "const a = 6\nconst x = a\n  / /ab/.source.length\nlog.push(x)",
    ],
    [
      "a call",
      "const a = () => 6\nconst x = a() / /ab/.source.length\nlog.push(x)",
    ],
    [
      "an index",
      "const a = [6]\nconst x = a[0] / /ab/.source.length\nlog.push(x)",
    ],
    ["a string", "const x = '6' / /ab/.source.length\nlog.push(x)"],
    ["a template", "const x = `6` / /ab/.source.length\nlog.push(x)"],
    [
      "a postfix update",
      "let a = 6\nconst x = a++ / /ab/.source.length\nlog.push(x, a)",
    ],
    [
      "a regex property",
      "const x = /abcd/.source.length / /ab/.source.length\nlog.push(x)",
    ],
    [
      "a block comment",
      "const a = 6\nconst x = a / /* by */ /ab/.source.length\nlog.push(x)",
    ],
    [
      "no space at all",
      "const a = 6\nconst x = a/ /ab/.source.length\nlog.push(x)",
    ],
  ])("keeps a division by a regex after %s", (_name, source) => {
    const minified = expectSameProgram(source);
    expect(minified).toContain("log.push(");
  });
});

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

describe("minifyJs – else or while on the line after a value's closing brace", () => {
  // The `}` ends an object literal or a function, not the `if` body: `else` needs a `;` first.
  it.each([
    [
      "an object literal",
      "let x\nif (log.length) x = { a: 1 }\nelse x = { a: 2 }\nlog.push(x.a)",
    ],
    [
      "an empty object",
      "let x\nif (!log.length) x = {}\nelse x = null\nlog.push(typeof x)",
    ],
    [
      "an object holding a string",
      "let x\nif (log.length) x = { a: 'b' }\nelse x = { a: `c` }\nlog.push(x.a)",
    ],
    [
      "a returned object",
      "const f = (a) => {\n  if (a) return { a }\n  else return { a: 0 }\n}\nlog.push(f(1).a, f(0).a)",
    ],
    [
      "a function expression",
      "let cb\nif (log.length) cb = function () { return 1 }\nelse cb = function () { return 2 }\nlog.push(cb())",
    ],
    [
      "a function expression on several lines",
      "let cb\nif (log.length) cb = function ()\n{\n  return 1\n}\nelse cb = () => 2\nlog.push(cb())",
    ],
    [
      "an arrow function body",
      "let cb\nif (log.length) cb = () => { return 1 }\nelse cb = () => { return 2 }\nlog.push(cb())",
    ],
    [
      "an async function expression",
      "let cb\nif (log.length) cb = async function () {}\nelse cb = () => 2\nlog.push(cb())",
    ],
    [
      "a returned function expression",
      "const f = (a) => {\n  if (a) return function () { return 1 }\n  else return () => 2\n}\nlog.push(f(1)(), f(0)())",
    ],
    [
      "a class expression",
      "let C\nif (log.length) C = class { a() { return 1 } }\nelse C = class { a() { return 2 } }\nlog.push(new C().a())",
    ],
    [
      "an object in a call argument list",
      "let x = 0\nconst f = (...a) => a.length\nif (log.length) x = f({}, {\n})\nelse x = f({\n})\nlog.push(x)",
    ],
    [
      "an object before a while loop",
      "let n = 0\nconst seen = {}\nwhile (n < 2) n++\nlog.push(n, typeof seen)",
    ],
    [
      "an assigned object before a while loop",
      "let n = 0, seen\nseen = {}\nwhile (n < 2) { n++ }\nlog.push(n, typeof seen)",
    ],
    [
      "a function expression before a while loop",
      "let n = 0\nconst f = function () {}\nwhile (n < 2) n++\nlog.push(n, typeof f)",
    ],
    [
      "an object as a do body",
      "let n = 0, x\ndo x = { n: n++ }\nwhile (n < 2)\nlog.push(n, x.n)",
    ],
  ])("ends the statement after %s", (_name, source) => {
    expectSameProgram(source);
  });

  // The `}` ends the block that `else` or `while` belongs to: no `;` may come between them.
  it.each([
    [
      "an if block",
      "let x\nif (log.length) { x = 1 }\nelse { x = 2 }\nlog.push(x)",
    ],
    [
      "an if block holding an object",
      "let x\nif (log.length) {\n  x = { a: 1 }\n}\nelse {\n  x = { a: 2 }\n}\nlog.push(x.a)",
    ],
    [
      "a nested loop block",
      "let x = 0\nif (!log.length) for (const a of [1, 2]) { x += a }\nelse x = 9\nlog.push(x)",
    ],
    [
      "a nested try",
      "let x = 0\nif (!log.length) try { x = 1 } catch { x = 2 }\nelse x = 9\nlog.push(x)",
    ],
    [
      "an else-if chain",
      "let x = 0\nif (log.length) { x = 1 }\nelse if (x) { x = 2 }\nelse { x = 3 }\nlog.push(x)",
    ],
    ["a do block", "let n = 0\ndo {\n  n++\n}\nwhile (n < 2)\nlog.push(n)"],
    [
      "a do block holding a function expression",
      "let n = 0, f\ndo {\n  f = function () { return n }\n  n++\n}\nwhile (n < 2)\nlog.push(n, f())",
    ],
    [
      "a function declaration",
      "let x = 0\nif (!log.length) { function f() { x = 1 }\n  f()\n}\nelse x = 2\nlog.push(x)",
    ],
    [
      "a labeled block inside an if",
      "let x = 0\nif (!log.length) a: { x = 1 }\nelse x = 2\nlog.push(x)",
    ],
  ])("keeps %s joined to what follows", (_name, source) => {
    const minified = expectSameProgram(source);
    expect(minified).not.toMatch(/\};(?:else|while)/);
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

describe("minifyJs – a declaration keyword at the end of a line", () => {
  // `var`, `let`, `const`, `function` and `class` need the name on the next line.
  it.each([
    ["var", "var\n  a = 1,\n  b = 2\nlog.push(a, b)"],
    ["const", "const\n  a = 1,\n  b = 2\nlog.push(a, b)"],
    ["let", "let\n  a = 1,\n  b = 2\na++\nlog.push(a, b)"],
    ["var then a comment", "var // names\n  a = 1\nlog.push(a)"],
    [
      "var then a doc comment",
      "var\n  /** the first */\n  a = 1,\n  /** the second */\n  b = 2;\nlog.push(a, b)",
    ],
    [
      "const then a pattern",
      "const\n  { a } = { a: 1 },\n  [b] = [2]\nlog.push(a, b)",
    ],
    ["var in a for header", "for (var\n  i = 0; i < 2; i++) log.push(i)"],
    ["function", "function\nf(a)\n{\n  return a + 1\n}\nlog.push(f(1))"],
    [
      "a function expression",
      "const f = function\ng() { return typeof g }\nlog.push(f())",
    ],
    ["class", "class\nA { m() { return 1 } }\nlog.push(new A().m())"],
    [
      "a property named var",
      "const o = { var: 1, let: 2, const: 3, class: 4, function: 5 }\nlet t = o.var\nt += o.let\nt += o.const\nt += o.class\nt += o.function\nlog.push(t)",
    ],
    [
      "a name ending in a keyword",
      "const $var = 1, _let = 2, myclass = 3\nlet t = $var\nt += _let\nt += myclass\nlog.push(t)",
    ],
  ])("continues after %s", (_name, source) => {
    expectSameProgram(source);
  });
});

describe("minifyJs – a private name spelled like a keyword at the end of a line", () => {
  // `this.#class` is a value, so the line break after it ends the statement.
  it.each([
    [
      "a declaration keyword",
      'class A {\n  #class = "x"\n  #let = 2\n  read() {\n    const c = this.#class\n    const l = this.#let\n    return c + l\n  }\n}\nlog.push(new A().read())',
    ],
    [
      "an operator keyword",
      "class A {\n  #default = 1\n  #new = 2\n  read() {\n    const d = this.#default\n    const n = this.#new\n    return d + n\n  }\n}\nlog.push(new A().read())",
    ],
    [
      "a field without a value",
      "class A {\n  #class\n  #default\n  set() {\n    this.#class = 1\n    this.#default = 2\n    return this.#class + this.#default\n  }\n}\nlog.push(new A().set())",
    ],
  ])("ends the statement after %s", (_name, source) => {
    expectSameProgram(source);
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
    // A binding name with no initializer cannot be called or indexed either.
    "var p\n[true, false].forEach((v) => log.push(v))",
    "let argv\n[argv] = [7]\nlog.push(argv)",
    "let a, b\n(() => log.push('iife'))()",
    "const x = 2\n;[1].forEach((v) => log.push(v, x))",
    // A postfix update cannot be called or indexed, so ASI ends the statement.
    "let i = 1; i++\n(() => log.push(i))()",
    "let i = 1; i--\n[1].forEach((v) => log.push(v, i))",
  ])("runs the same program as the source: %j", (source) => {
    expectSameProgram(source);
  });

  // The last binding has no initializer even though an earlier one has: still a name.
  it.each([
    [
      "an index line after `var a = 1, b`",
      "var a = 1, b\n[2, 3].forEach((v) => log.push(v, a, b))",
    ],
    [
      "a call line after `let a = 1, b`",
      "let a = 1, b\n(() => log.push('iife', a, b))()",
    ],
    [
      "three bindings, the middle one initialized",
      "const f = () => 1\nlet a, b = f(), c\n[a, c] = [4, 5]\nlog.push(a, b, c)",
    ],
    [
      "an initializer holding a call and a comma",
      "const f = (x, y) => x + y\nvar a = f(1, 2), b\n[a].forEach((v) => log.push(v, b))",
    ],
    [
      "an initializer holding an object and an array",
      "var a = { k: [1, 2] }, b\n[a.k].forEach((v) => log.push(v, b))",
    ],
    [
      "an initializer holding a function with its own declaration",
      "var a = function () { var x = 1, y\n return x }, b\n[a()].forEach((v) => log.push(v, b))",
    ],
    [
      "a declaration in a function body",
      "function g() {\n  let a = 1, b\n  [a].forEach((v) => log.push(v, b))\n}\ng()",
    ],
    [
      "a sign line after a bare name",
      "const z = 3\nvar a = 1, b\n-z\nlog.push(a, b)",
    ],
    [
      "a plus line after a bare declaration",
      "const z = 3\nlet p\n+z\nlog.push(p)",
    ],
    ["a template line after a bare name", "var a = 1, b\n`x`\nlog.push(a, b)"],
  ])("ends the declaration after %s", (_name, source) => {
    expectSameProgram(source);
  });

  // Not a declaration's last binding: the next line continues the value or the call.
  it.each([
    [
      "a call's last argument",
      "const f = (a, b) => b\nconst v = [[7]], i = 0\nlog.push(f(1, v\n[i]))",
    ],
    [
      "a name after a statement that followed a declaration",
      "const o = { b: [9] }\nvar a = 1\nlet c = o, d = o.b\nd\n[0]\nlog.push(a, c.b[0], d)",
    ],
    [
      "an expression statement on the line after a declaration",
      "const b = [[8]], c = 0\nvar a = 1\nlog, b\n[c]\nlog.push(a, b[0][0])",
    ],
    ["a for header", "for (let i = 0, n = 2; i < n; i++) log.push(i)"],
    [
      "a for-in header with a name on its own line",
      "const o = { k: 1 }\nfor (var k\n in o) log.push(k)",
    ],
    ["an initializer on the next line", "var a = 1, b\n  = 2\nlog.push(a, b)"],
    ["a comma on the next line", "var a = 1, b\n  , c = 3\nlog.push(a, b, c)"],
    [
      "a destructuring pattern's names",
      "const o = { a: 1, b: [[6]] }, i = 0\nconst { a, b } = o\nlog.push(a, b\n[i])",
    ],
  ])("still joins %s", (_name, source) => {
    expectSameProgram(source);
  });

  it("reads a declaration that ends in an initializer as any other line", () => {
    // `const x = 1\n[1]` is `const x = 1[1]` in the source as well.
    expect(minifyJs("const x = 1\n[1].map(f)")).toBe("const x=1[1].map(f)");
    // A property spelled like a keyword is not a declaration.
    expect(minifyJs("x = a.var\n[0]")).toBe("x=a.var[0]");
  });

  it("joins a keyword with its parenthesized header on the next line", () => {
    expect(minifyJs("if\n(a) b()")).toBe("if(a)b()");
    expect(minifyJs("while\n(a) b()")).toBe("while(a)b()");
    expect(minifyJs("typeof\n(a)")).toBe("typeof(a)");
  });
});

describe("minifyJs – any line after a restricted production starts a new statement", () => {
  it.each([
    // `return\n-z` returns undefined; `return-z` would return -z.
    "const z = 5\nlog.push((() => { return\n-z })())",
    "const z = 5\nlog.push((() => { return\n+z })())",
    "for (;;) { log.push('once'); break\n+1 }",
    "for (const x of [1, 2]) { log.push(x); continue\n/re/.test('re') }",
    "function* g() { yield\n-1 }\nlog.push([...g()])",
    "a: for (;;) { log.push('a'); break a\n-1 }",
    "log.push((() => { return\n})())",
  ])("runs the same program as the source: %j", (source) => {
    expectSameProgram(source);
  });

  it("puts the `;` after the restricted production", () => {
    expect(minifyJs("function f() { return\n-z }")).toBe(
      "function f(){return;-z}",
    );
    // A property named `return` is a value, and the operator continues it.
    expect(minifyJs("o.return\n-z")).toBe("o.return-z");
  });
});

describe("minifyJs – a line starting with != or !==", () => {
  // `!=` is a binary operator: the comparison continues the line before it.
  it.each([
    ["a name", "const a = 1, b = 2\nconst x = a\n  !== b\nlog.push(x)"],
    ["a name and !=", "const a = 1, b = '1'\nconst x = a\n  != b\nlog.push(x)"],
    ["a call", "const a = () => 1\nconst x = a()\n  !== 1\nlog.push(x)"],
    ["an index", "const a = [1]\nconst x = a[0]\n  !== 2\nlog.push(x)"],
    ["a string", "const x = 'a'\n  !== 'b'\nlog.push(x)"],
    ["a template", "const x = `a`\n  !== `b`\nlog.push(x)"],
    ["an object", "const o = {}\nconst x = {}\n  !== o\nlog.push(x)"],
    ["a postfix update", "let a = 1\nconst x = a++\n  !== 1\nlog.push(x, a)"],
    [
      "a condition over two lines",
      "const a = 'x', b = 'y'\nif (a.toString('binary')\n  !== b.toString('binary')) log.push('differs')",
    ],
  ])("continues the comparison after %s", (_name, source) => {
    expect(expectSameProgram(source)).not.toContain(";!");
  });

  it.each([
    ["a name", "let a = 1, b = 0\na\n!b\nlog.push(a, b)"],
    [
      "a string",
      "const b = () => log.push('b')\nconst a = 'x'\n!b()\nlog.push(a)",
    ],
    [
      "an IIFE",
      "const a = 1\n!function () { log.push('iife') }()\nlog.push(a)",
    ],
  ])("still starts a statement at a lone ! after %s", (_name, source) => {
    expect(expectSameProgram(source)).toContain(";!");
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

  const PARITY_BOUNDS = propertyBounds(500);
  it(
    "runs the same program minified as unminified",
    () => {
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
        PARITY_BOUNDS.options,
      );
    },
    PARITY_BOUNDS.timeoutMs,
  );
});

describe("minifyJs – a class field name before a computed or generator member", () => {
  // `name\n[key] = 1` is two fields: a field name cannot be indexed, so the line break ends it.
  it.each([
    [
      "a field then a computed field",
      "const k = 'key'\nclass A {\n  first\n  [k] = 1\n}\nconst a = new A()\nlog.push('first' in a, a.key)",
    ],
    [
      "a private field then a computed field",
      "const k = 'key'\nclass A {\n  #abort\n  [k] = null\n  has() { return #abort in this }\n}\nconst a = new A()\nlog.push(a.has(), a.key)",
    ],
    [
      "a static field then a computed field",
      "const k = 'key'\nclass A {\n  static first\n  [k] = 1\n}\nlog.push('first' in A, new A().key)",
    ],
    [
      "a field then a computed method",
      "const k = 'key'\nclass A {\n  first\n\n  // the method\n  [k]() { return 2 }\n}\nconst a = new A()\nlog.push('first' in a, a.key())",
    ],
    [
      "a field then a generator method",
      "class A {\n  first\n  *items() { yield 1 }\n}\nconst a = new A()\nlog.push('first' in a, [...a.items()])",
    ],
    [
      "a field after a method",
      "const k = 'key'\nclass A {\n  m() { return 1 }\n  first\n  [k] = 2\n}\nconst a = new A()\nlog.push(a.m(), 'first' in a, a.key)",
    ],
    [
      "a private field after fields with values",
      "const k = 'key'\nclass A {\n  #paused = false\n  #reason = null\n  #abort\n  [k] = 2\n  has() { return #abort in this && !this.#paused && !this.#reason }\n}\nconst a = new A()\nlog.push(a.has(), a.key)",
    ],
    [
      "a field after a field with a string value",
      "const k = 'key'\nclass A {\n  label = 'x'\n  first\n  [k] = 2\n}\nconst a = new A()\nlog.push(a.label, 'first' in a, a.key)",
    ],
    [
      "a field after a field with a call value",
      "const k = 'key', f = () => 1\nclass A {\n  n = f()\n  first\n  *[k]() { yield 2 }\n}\nconst a = new A()\nlog.push(a.n, 'first' in a, [...a.key()])",
    ],
    [
      "a class expression in a field value",
      "const k = 'key'\nclass A {\n  static Inner = class {\n    first\n    [k] = 3\n  }\n}\nconst i = new A.Inner()\nlog.push('first' in i, i.key)",
    ],
    [
      "a field named async",
      "const k = 'key'\nclass A {\n  async\n  [k]() { return 4 }\n}\nconst a = new A()\nlog.push('async' in a, a.key())",
    ],
  ])("ends %s", (_name, source) => {
    expectSameProgram(source);
  });

  // Here the `[` or `*` line belongs to what is before it.
  it.each([
    [
      "static",
      "const k = 'key'\nclass A {\n  static\n  [k] = 1\n}\nlog.push(A.key)",
    ],
    [
      "get",
      "const k = 'key'\nclass A {\n  get\n  [k]() { return 2 }\n}\nlog.push(new A().key)",
    ],
    [
      "a static generator",
      "class A {\n  static\n  *items() { yield 3 }\n}\nlog.push([...A.items()])",
    ],
    [
      "a field value that is indexed",
      "const b = [4]\nclass A {\n  first = b\n  [0]\n}\nlog.push(new A().first)",
    ],
    [
      "a field value that is multiplied",
      "const b = 5\nclass A {\n  first = b\n  * 2\n}\nlog.push(new A().first)",
    ],
    [
      "an index inside a method",
      "const b = [6]\nclass A {\n  m() {\n    return b\n      [0]\n  }\n}\nlog.push(typeof new A().m())",
    ],
    [
      "an expression statement inside a method",
      "const b = [7]\nclass A {\n  m() {\n    const c = b\n    [0]\n    return c\n  }\n}\nlog.push(new A().m())",
    ],
  ])("keeps %s joined to the next line", (_name, source) => {
    expectSameProgram(source);
  });
});

describe("minifyJs – a class field named like a keyword on a line of its own", () => {
  // `class A {\n  let\n  foo() {}\n}` is a field named `let`, then a method: as a member name
  // the word takes nothing next, so the line break ends the field.
  const words = [
    "else",
    "do",
    "try",
    "finally",
    "in",
    "instanceof",
    "typeof",
    "void",
    "delete",
    "new",
    "case",
    "extends",
    "default",
    "export",
    "import",
    "var",
    "let",
    "const",
    "function",
    "class",
  ];

  it.each(words)("ends a field named %s before a method", (word) => {
    const minified = expectSameProgram(
      `class A {\n  ${word}\n  foo() { return 1 }\n}\nconst a = new A()\nlog.push(${JSON.stringify(word)} in a, a.foo())`,
    );
    expect(minified).toContain(`${word};foo(`);
  });

  it.each(words)("ends a field named %s before a field", (word) => {
    expectSameProgram(
      `class A {\n  ${word}\n  bar = 2\n}\nconst a = new A()\nlog.push(${JSON.stringify(word)} in a, a.bar)`,
    );
  });

  it.each(words)("ends a static or private field named %s", (word) => {
    expectSameProgram(
      `class A {\n  static ${word}\n  #${word}\n  bar = 2\n  has() { return #${word} in this }\n}\nlog.push(${JSON.stringify(word)} in A, new A().has(), new A().bar)`,
    );
  });

  it.each(words)("ends a field named %s before another one", (word) => {
    // The second word starts a member too: `typeof\nvoid\nx` is three fields.
    const next = word === "void" ? "typeof" : "void";
    expectSameProgram(
      `class A {\n  ${word}\n  ${next}\n  bar = 2\n}\nconst a = new A()\nlog.push(${JSON.stringify(word)} in a, ${JSON.stringify(next)} in a, a.bar)`,
    );
  });

  it.each([
    ["after the modifier on its line", "static static"],
    ["on the line after the modifier", "static\n  static"],
  ])("ends a static field named static %s", (_name, member) => {
    expectSameProgram(
      `class A {\n  ${member}\n  foo() { return 12 }\n}\nlog.push('static' in A, typeof A.prototype.foo)`,
    );
  });

  it.each(words)("ends a field named %s after a field with a value", (word) => {
    // `in` and `instanceof` after a value continue it (`n = 1\nin\nfoo`), so those two
    // are only a member name after a `;`.
    const separator = word === "in" || word === "instanceof" ? ";" : "";
    expectSameProgram(
      `class A {\n  n = 1${separator}\n  ${word}\n  foo() { return 3 }\n}\nconst a = new A()\nlog.push(a.n, ${JSON.stringify(word)} in a, a.foo())`,
    );
  });

  it.each([
    [
      "a method named after the word on the next line",
      "class A {\n  default\n  () { return 4 }\n}\nlog.push(new A().default())",
    ],
    [
      "a field value on the next line",
      "class A {\n  let\n  = 5\n}\nlog.push(new A().let)",
    ],
    [
      "a static modifier",
      "class A {\n  static\n  foo() { return 6 }\n}\nlog.push(typeof A.foo, typeof A.prototype.foo)",
    ],
    [
      "a get modifier",
      "class A {\n  get\n  foo() { return 7 }\n}\nlog.push(new A().foo)",
    ],
    [
      "a static modifier before a field named let",
      "class A {\n  static\n  let\n  foo() { return 8 }\n}\nlog.push('let' in A, typeof A.prototype.foo)",
    ],
    [
      "a class expression's heritage on the next line",
      "class B { n() { return 9 } }\nclass A {\n  static C = class\n  extends\n  B {}\n}\nlog.push(new A.C().n())",
    ],
    [
      "a declaration inside a method",
      "class A { m() { var\n x = 7\n return x } }\nlog.push(new A().m())",
    ],
    [
      "a declaration inside a static block",
      "class A { static { let\n y = 8\n log.push(y) } }",
    ],
    [
      "an operator in a field value",
      "class A {\n  t = typeof\n  log\n  n = 1 instanceof\n  Object\n}\nconst a = new A()\nlog.push(a.t, a.n)",
    ],
    [
      "an `in` after a field value",
      "const o = { foo: 1 }\nclass A {\n  n = 'foo'\n  in\n  o\n}\nlog.push(new A().n)",
    ],
    [
      "an object literal key",
      "const o = {\n  let\n  : 9,\n  class\n  : 10\n}\nlog.push(o.let, o.class)",
    ],
    [
      "a nested class in a method",
      "class A {\n  m() {\n    class\n    B { n() { return 11 } }\n    return new B().n()\n  }\n}\nlog.push(new A().m())",
    ],
  ])("keeps %s joined", (_name, source) => {
    expectSameProgram(source);
  });
});

// A `{` on its own line after a function, method, class or catch header opens that header's
// body. It is what brace-on-next-line code looks like, and what a TypeScript function with a
// multi-line return type looks like once its types are stripped to spaces.
describe("minifyJs – a body brace on the line after its header", () => {
  it.each([
    [
      "function declaration",
      "function f(a)\n{\n  return a + 1;\n}\nlog.push(f(1));",
    ],
    [
      "default parameter with parentheses",
      "function f(a, b = (2))\n{\n  return a + b;\n}\nlog.push(f(1));",
    ],
    [
      "function expression",
      "const f = function (a)\n{\n  return a * 2;\n}\nlog.push(f(2));",
    ],
    [
      "function expression passed as an argument",
      "[1, 2].forEach(function (n)\n{\n  log.push(n);\n});",
    ],
    [
      "generator",
      "function* g(a)\n{\n  yield a;\n}\nfunction *h()\n{\n  yield 2;\n}\nlog.push([...g(1), ...h()]);",
    ],
    [
      "async function",
      "async function f(a)\n{\n  return a;\n}\nlog.push(typeof f(1).then);",
    ],
    [
      "class and its members",
      [
        "class A",
        "{",
        "  static count = 1",
        "  static",
        "  {",
        "    A.count = 2;",
        "  }",
        "  #secret()",
        "  {",
        "    return 3;",
        "  }",
        "  constructor(a)",
        "  {",
        "    this.a = a;",
        "  }",
        "  get double()",
        "  {",
        "    return this.a * 2;",
        "  }",
        "  static make(a)",
        "  {",
        "    return new A(a);",
        "  }",
        "  ['computed']()",
        "  {",
        "    return this.#secret();",
        "  }",
        "  'quoted'()",
        "  {",
        "    return 4;",
        "  }",
        "  *items()",
        "  {",
        "    yield this.a;",
        "  }",
        "}",
        "const a = A.make(5);",
        "log.push(A.count, a.double, a.computed(), a.quoted(), [...a.items()]);",
      ].join("\n"),
    ],
    [
      "class with a heritage clause",
      "class B\n{\n  hi()\n  {\n    return 1;\n  }\n}\nclass A extends B\n{\n}\nconst mix = (C) => C;\nclass D extends mix(B)\n{\n}\nlog.push(new A().hi(), new D().hi());",
    ],
    [
      "class expression",
      "const C = class\n{\n  hi()\n  {\n    return 1;\n  }\n};\nlog.push(new C().hi());",
    ],
    [
      "object literal methods",
      "const o = {\n  m(a)\n  {\n    return a;\n  },\n  get x()\n  {\n    return 2;\n  },\n  nested: {\n    n()\n    {\n      return 3;\n    }\n  }\n};\nlog.push(o.m(1), o.x, o.nested.n());",
    ],
    [
      "object literal returned and passed",
      "const make = () =>\n{\n  return {\n    m()\n    {\n      return 1;\n    }\n  };\n};\nconst call = (o) => o.m();\nlog.push(make().m(), call({\n  m()\n  {\n    return 2;\n  }\n}));",
    ],
    [
      "try, catch and finally",
      "try\n{\n  throw new Error('x');\n}\ncatch (e)\n{\n  log.push(e.message);\n}\nfinally\n{\n  log.push('done');\n}",
    ],
    [
      "catch without a binding",
      "try\n{\n  throw 1;\n}\ncatch\n{\n  log.push('caught');\n}",
    ],
    [
      "a stripped multi-line return type",
      "function f(a        )   \n               \n                   \n  {\n  return { ok: a };\n}\nlog.push(f(true).ok);",
    ],
    [
      "a comment between the header and its brace",
      "function f(a) // adds one\n// to a\n{\n  return a + 1;\n}\nlog.push(f(1));",
    ],
  ])("%s", (_name, source) => {
    const minified = expectSameProgram(source);
    expect(minified).not.toContain(";{");
    expect(minified).not.toContain("\n");
  });

  // The line break ends the statement in each of these: the `{` starts a block of its own.
  it.each([
    ["a call", "let n = 0\nconst foo = () => n++\nfoo()\n{\n  log.push(n);\n}"],
    ["an assignment", "let x\nconst y = 1\nx = y\n{\n  log.push(x);\n}"],
    ["a declaration", "let a = 1\n{\n  a++;\n}\nlog.push(a);"],
    [
      "a method call",
      "const a = { b: (c) => log.push(c) }\na.b(1)\n{ log.push(2) }",
    ],
    [
      "a constructor call",
      "function Foo(a) { log.push(a) }\nnew Foo(1)\n{ log.push(2) }",
    ],
    [
      "a call inside a function whose own brace is on the next line",
      "const g = (a) => log.push(a)\nfunction f(a)\n{\n  g(a)\n  {\n    log.push('block');\n  }\n}\nf(1);",
    ],
    [
      "a call inside a method whose own brace is on the next line",
      "const g = (a) => log.push(a)\nclass A\n{\n  m(a)\n  {\n    g(a)\n    {\n      log.push('block');\n    }\n  }\n}\nnew A().m(1);",
    ],
    [
      "a property named catch or function",
      "const p = { catch: (f) => log.push('c'), function: (f) => log.push('f') }\np.catch(1)\n{ log.push(1) }\np.function(2)\n{ log.push(2) }",
    ],
    [
      "a function expression that already has its body",
      "let x\nx = function () {}\n{ log.push(typeof x) }",
    ],
    [
      "a catch with no binding, then a call",
      "const b = () => log.push('b')\ntry\n{\n  throw 1;\n}\ncatch\n{\n  b()\n  {\n    log.push('block');\n  }\n}",
    ],
  ])("still ends the statement after %s", (_name, source) => {
    expect(expectSameProgram(source)).toContain(";{");
  });

  it("joins a class body across a string in its heritage clause", () => {
    expectSameProgram(
      "const mix = () => Object;\nclass A extends mix('x')\n{\n  hi()\n  {\n    return 1;\n  }\n}\nlog.push(new A().hi());",
    );
  });
});

describe("minifyJs – a call that only looks like a control header", () => {
  // `Symbol.for(...)`, `list.with(...)` and `$if(...)` are calls: the line break after them
  // ends the statement, unlike the one after `for (...)` or `if (...)`.
  it.each([
    [
      "Symbol.for with a string",
      "const k = Symbol.for('app.key')\nconst y = 2\nlog.push(typeof k, y)",
    ],
    [
      "Symbol.for with a name",
      "const name = 'k'\nconst k = Symbol.for(name)\nconst y = 2\nlog.push(typeof k, y)",
    ],
    [
      "Array.prototype.with",
      "const a = [1, 2]\nconst b = a.with(0, 9)\nlog.push(b[0])",
    ],
    [
      "a method named if, while or switch",
      "const o = { if: (v) => log.push(v), while: (v) => log.push(v), switch: (v) => log.push(v) }\no.if(1)\no.while(2)\no.switch('3')\nlog.push(4)",
    ],
    [
      "a property reached across a line break",
      "const o = { for: (v) => v }\nconst r = o\n  .for(1)\nlog.push(r)",
    ],
    [
      "a property after a space",
      "const o = { for: (v) => v }\nconst r = o. for(1)\nlog.push(r)",
    ],
    [
      "an optional call",
      "const o = { for: (v) => v }\nconst r = o?.for(1)\nlog.push(r)",
    ],
    [
      "a name ending in a keyword after $",
      "const $if = (v) => v, $for = (v) => v\nconst a = $if(1)\nconst b = $for('2')\nlog.push(a, b)",
    ],
    [
      "a division after such a call",
      "const o = { with: (v) => v }, g = 2\nconst r = o.with(8) / 2 / g\nlog.push(r)",
    ],
  ])("ends the statement after %s", (_name, source) => {
    expectSameProgram(source);
  });

  it.each([
    ["for", "for (const a of [1, 2])\n  log.push(a)\nlog.push('done')"],
    [
      "if",
      "const a = 1\nif (a === 1)\n  log.push('one')\nelse\n  log.push('other')",
    ],
    ["while", "let n = 0\nwhile (n < 2)\n  n++\nlog.push(n)"],
    ["nested call", "const f = (v) => v\nif (f(f(1)))\n  log.push('one')"],
  ])("still joins a real %s header to its body", (_name, source) => {
    expectSameProgram(source);
  });

  // `new Function` bodies cannot hold `for await`, so these compare text.
  it.each([
    [
      "async function f(o) {\n  for await (const a of o)\n  {\n    use(a)\n  }\n}",
      "async function f(o){for await(const a of o){use(a)}}",
    ],
    [
      "async function f(o) {\n  for await (const a of o)\n    use(a)\n  done()\n}",
      "async function f(o){for await(const a of o)use(a);done()}",
    ],
    [
      "async function f(o) {\n  for await (const a of o) /x/.test(a) && use(a)\n}",
      "async function f(o){for await(const a of o)/x/.test(a)&&use(a)}",
    ],
    ["const r = o.for\nawait (a)\nb()", "const r=o.for;await(a);b()"],
  ])("reads the header of `for await`: %j", (source, expected) => {
    expect(minifyJs(source)).toBe(expected);
  });

  it.each([
    [
      "a string",
      "const a = 'x'\nswitch (a + 'y')\n{\n  case 'xy':\n    log.push(1)\n}",
    ],
    [
      "a template",
      "const a = 'x'\nswitch (`${a}y`)\n{\n  case 'xy':\n    log.push(1)\n}",
    ],
    ["a regex", "switch (/x/.test('x'))\n{\n  case true:\n    log.push(1)\n}"],
    [
      "a call",
      "const f = (v) => v\nswitch (f(f(1)))\n{\n  case 1:\n    log.push(1)\n}",
    ],
    ["a name", "const a = 1\nswitch (a)\n{\n  case 1:\n    log.push(1)\n}"],
  ])(
    "joins a switch header holding %s to a `{` on the next line",
    (_name, source) => {
      expect(expectSameProgram(source)).not.toContain(";{");
    },
  );
});

describe("minifyJs – `extends` on the line after a class name", () => {
  // `class D\nextends B {}` is one class header: the line break is not a statement end.
  it.each([
    [
      "a class declaration",
      "class B {}\nclass D\nextends B {}\nlog.push(new D() instanceof B)",
    ],
    [
      "a named class expression",
      "class B {}\nconst X = class D\n  extends B {}\nlog.push(new X() instanceof B)",
    ],
    [
      "a class declared in a method",
      "class B {}\nclass A { m() { class D\nextends B {}\n return D } }\nlog.push(new (new A().m())() instanceof B)",
    ],
    [
      "a class expression in a field",
      "class B {}\nclass A { x = class D\n extends B {} }\nlog.push(new (new A().x)() instanceof B)",
    ],
    [
      "a heritage call and the body on lines of their own",
      "const mix = (C) => C\nclass B {}\nclass D\n  extends mix(B)\n{\n  m() { return 1 }\n}\nlog.push(new D().m(), new D() instanceof B)",
    ],
    [
      "a comment between the name and extends",
      "class B {}\nclass D // child\nextends B {}\nlog.push(new D() instanceof B)",
    ],
  ])("keeps %s together", (_name, source) => {
    expect(expectSameProgram(source)).not.toMatch(/;extends/);
  });

  it.each([
    [
      "a method named extends after a field",
      "class A {\n  foo\n  extends() { return 2 }\n}\nlog.push(new A().extends(), 'foo' in new A())",
    ],
    [
      "a property named extends",
      "const o = { extends: 3 }\nconst v = o\n  .extends\nlog.push(v)",
    ],
  ])("still reads %s", (_name, source) => {
    expectSameProgram(source);
  });
});
