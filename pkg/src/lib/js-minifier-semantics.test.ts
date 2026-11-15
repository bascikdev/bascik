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
