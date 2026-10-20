import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { minifyJs } from "./js-minifier.ts";

it("preserves binary continuations across line breaks", () => {
  const sources = [
    "let x = 1; return x++\ninstanceof Object;",
    "let x = 1; return (x--\nin { 1: true });",
    "let x = 4; return x++\n/ 2;",
    "let x = 4; return x--\n/ 2;",
    "let value = 8; return value\n/ 2;",
    "return { valueOf() { return 8; } }\n/ 2;",
    "let x = 1; return x++\ninstanceofValue();",
  ];
  for (const source of sources) {
    const minified = minifyJs(source);
    expect(() => new Function(minified)).not.toThrow();
    if (!source.includes("instanceofValue")) {
      expect(new Function(minified)()).toEqual(new Function(source)());
    }
  }
});

describe("minifyJs – basic comment stripping and whitespace collapsing", () => {
  it("removes block comments", () => {
    expect(minifyJs("/* hello */var x = 1;")).toBe("var x=1;");
  });

  it("removes line comments", () => {
    expect(minifyJs("var x = 1; // comment\nvar y = 2;")).toBe(
      "var x=1;var y=2;",
    );
  });

  it("removes line comments at the end of file without newline", () => {
    expect(minifyJs("var x = 1; // comment")).toBe("var x=1;");
  });

  it("collapses multiple spaces and tabs to a single space", () => {
    expect(minifyJs("var  x  =  1;")).toBe("var x=1;");
  });

  it("collapses multiple blank lines", () => {
    expect(minifyJs("var x = 1;\n\n\nvar y = 2;")).toBe("var x=1;var y=2;");
  });

  it("adds space when block comment separates adjacent word tokens", () => {
    expect(minifyJs("return/*x*/value;")).toBe("return value;");
  });

  it("trims leading and trailing whitespace", () => {
    expect(minifyJs("\n  var x = 1;  \n")).toBe("var x=1;");
  });

  it("handles empty input", () => {
    expect(minifyJs("")).toBe("");
  });
});

describe("minifyJs – string and template literal preservation", () => {
  it("preserves double-quoted strings verbatim", () => {
    expect(minifyJs('var s = "hello  world"; // end')).toBe(
      'var s="hello  world";',
    );
  });

  it("preserves single-quoted strings verbatim", () => {
    expect(minifyJs("var s = 'hello  world';")).toBe("var s='hello  world';");
  });

  it("preserves strings containing comment slashes", () => {
    expect(minifyJs('var url = "https://example.com/a//b";')).toBe(
      'var url="https://example.com/a//b";',
    );
  });

  it("preserves template literals verbatim including newlines and spacing", () => {
    const input = "var s = `hello\n  world`;";
    expect(minifyJs(input)).toBe("var s=`hello\n  world`;");
  });

  it("handles escape sequences in template literals", () => {
    expect(minifyJs("var s = `he said \\`hi\\``;")).toBe(
      "var s=`he said \\`hi\\``;",
    );
  });

  it("handles escape sequences in strings", () => {
    expect(minifyJs('var s = "he said \\"hi\\"";')).toBe(
      'var s="he said \\"hi\\"";',
    );
  });

  it("preserves template literals with interpolated expressions", () => {
    expect(minifyJs("var s = `sum is ${a + b}`;")).toBe(
      "var s=`sum is ${a + b}`;",
    );
  });

  it("preserves nested template literals inside interpolated expressions", () => {
    const input =
      "const value = `outer ${`See https://example.com/${name}`} tail`; return value;";
    const minified = minifyJs(input);

    expect(() => new Function("name", minified)).not.toThrow();
    expect(new Function("name", minified)("Ada")).toBe(
      "outer See https://example.com/Ada tail",
    );
  });

  it("preserves URL slashes after division following a call", () => {
    const input =
      "function buildUrl(host){const ratio=Date.now()/1e3;return `https://${host}/${host}/`; } function next(){return `done`;}";
    const minified = minifyJs(input);

    expect(
      () => new Function("host", `${minified};return buildUrl(host);`),
    ).not.toThrow();
    expect(
      new Function("host", `${minified};return buildUrl(host);`)(
        "login.example",
      ),
    ).toBe("https://login.example/login.example/");
  });
});

describe("minifyJs – regex literal after control-statement headers", () => {
  const run = (code: string, s: string): { out: unknown; threw?: string } => {
    const globalObj: Record<string, unknown> = {};
    try {
      new Function("s", "globalThis", code)(s, globalObj);
      return { out: globalObj.out };
    } catch (error) {
      return { out: undefined, threw: String(error) };
    }
  };

  it.each([
    ['if (ok) /"/.test(s) && (globalThis.hit = 1);', '"'],
    ["while (i--) /['\"]  x/.exec(s);", "x"],
    ["for (; i < 1; i++) /`/.test(s); ", "`"],
    ['with (s) /"/.test(s);', '"'],
    ['if (a) { } else if (b) /"/.test(s);', '"'],
  ])("keeps strings that follow a regex statement intact: %s", (header, s) => {
    const source = `var ok=true,i=0,a=false,b=true;\n${header}\nglobalThis.out = "a    b";`;
    const minified = minifyJs(source);
    expect(() => new Function("s", "globalThis", minified)).not.toThrow();
    expect(minified).toContain('"a    b"');
    expect(run(minified, s).out).toBe(run(source, s).out);
  });

  it("keeps strings that follow a regex statement after a block-closing brace", () => {
    const source =
      'function f(){}\n/["\']  y/.test(s);\nglobalThis.out = "a    b";';
    const minified = minifyJs(source);
    expect(minified).toContain('"a    b"');
    expect(run(minified, "y").out).toBe("a    b");
  });

  it("still treats a slash after a non-control parenthesis as division", () => {
    for (const source of [
      "const r = (8) / (4) / 2; globalThis.out = r;",
      "const f = (x) => x; const r = f(8) / 4 / 2; globalThis.out = r;",
    ]) {
      const minified = minifyJs(source);
      expect(run(minified, "").threw).toBeUndefined();
      expect(run(minified, "").out).toBe(run(source, "").out);
      expect(run(minified, "").out).toBe(1);
    }
  });

  it("preserves a regex containing a backtick inside a template interpolation", () => {
    const input =
      "const a = `x ${ /`/.test(y) ? 1 : 2 } z`; globalThis.out = a;";
    const minified = minifyJs(input);
    expect(() => new Function("y", "globalThis", minified)).not.toThrow();
    const globalObj: Record<string, unknown> = {};
    new Function("y", "globalThis", minified)("`", globalObj);
    expect(globalObj.out).toBe("x 1 z");
  });
});

describe("minifyJs – regex literal handling", () => {
  it("preserves a simple regex literal verbatim", () => {
    expect(minifyJs("var re = /abc/g;")).toBe("var re=/abc/g;");
  });

  it("preserves a regex literal with flags", () => {
    expect(minifyJs("var re = /hello world/gi;")).toBe(
      "var re=/hello world/gi;",
    );
  });

  it("does not confuse '/' in a character class with the closing delimiter", () => {
    expect(minifyJs("var re = /[/]/;")).toBe("var re=/[/]/;");
  });

  it("preserves a regex with escape sequences", () => {
    expect(minifyJs("var re = /a\\/b/;")).toBe("var re=/a\\/b/;");
  });

  it("treats '/' as division when regex is unterminated before newline", () => {
    const result = minifyJs("var n = /foo\n/bar;");
    expect(result).toBe("var n=/foo/bar;");
  });

  it("treats '/' as division (not regex start) after an identifier", () => {
    const result = minifyJs("var n = a/b;");
    expect(result).toBe("var n=a/b;");
  });

  it("handles a regex that contains a block comment string verbatim", () => {
    expect(minifyJs("var re = /\\/\\*/g;")).toBe("var re=/\\/\\*/g;");
  });

  it("handles regex literals after keywords expecting expressions", () => {
    expect(minifyJs("return /abc/.test(str);")).toBe("return/abc/.test(str);");
    expect(minifyJs("case /abc/.test(str):")).toBe("case/abc/.test(str):");
    expect(minifyJs("throw /abc/;")).toBe("throw/abc/;");
  });
});

describe("minifyJs – statement separation (ASI)", () => {
  it("inserts semicolon between variable declarations on new lines", () => {
    const input = "const a = 1\nconst b = 2";
    expect(minifyJs(input)).toBe("const a=1;const b=2");
  });

  it("inserts semicolon across a string literal segment", () => {
    const input = "const a = 'value'\nconst b = 2";
    expect(minifyJs(input)).toBe("const a='value';const b=2");
  });

  it("inserts semicolon between function calls on new lines", () => {
    const input = "foo()\nbar()";
    expect(minifyJs(input)).toBe("foo();bar()");
  });

  it("does NOT insert semicolon if line ends with an operator", () => {
    const input = "const a =\n1 + 2";
    expect(minifyJs(input)).toBe("const a=1+2");
  });

  it("does NOT insert semicolon if line ends with comma", () => {
    const input = "const a = {\n x: 1,\n y: 2\n}";
    expect(minifyJs(input)).toBe("const a={x:1,y:2}");
  });

  it("inserts semicolon after return statement followed by newline", () => {
    const input = "return\nx + y";
    expect(minifyJs(input)).toBe("return;x+y");
  });

  it("handles if-else blocks correctly without broken semicolons", () => {
    const input = "if (a) {\n  foo()\n} else {\n  bar()\n}";
    expect(minifyJs(input)).toBe("if(a){foo()}else{bar()}");
  });

  // Prettier puts a braceless body on its own line when the header and body do not fit on one line.
  // A string in the header splits it across scanner segments, which once hid the keyword and
  // emitted `if(a==="x");b=1;else c=2;`, a syntax error.
  it.each([
    ['if (a === "x")\n  b = 1;\nelse c = 2;', 'if(a==="x")b=1;else c=2;'],
    ["if (a === 'x')\n  f(1);\nelse g();", "if(a==='x')f(1);else g();"],
    ["if (a === `x`)\n  f();\nelse g();", "if(a===`x`)f();else g();"],
    [
      "if (a === /x/.source)\n  f();\nelse g();",
      "if(a===/x/.source)f();else g();",
    ],
    ['while (a !== "x")\n  a = next();', 'while(a!=="x")a=next();'],
    ['for (const k of o["x"])\n  use(k);', 'for(const k of o["x"])use(k);'],
    [
      'if (f("a", "b"))\n  g();\nelse if (h("c"))\n  i();\nelse\n  j();',
      'if(f("a","b"))g();else if(h("c"))i();else j();',
    ],
  ])(
    "keeps a braceless body on the next line attached to its header: %j",
    (input, expected) => {
      expect(minifyJs(input)).toBe(expected);
    },
  );

  it("still ends a call whose parentheses contain a string before a new statement", () => {
    expect(minifyJs('f("x")\ng()')).toBe('f("x");g()');
  });

  it("handles try-catch-finally blocks correctly", () => {
    const input = "try {\n  a()\n} catch (e) {\n  b()\n} finally {\n  c()\n}";
    expect(minifyJs(input)).toBe("try{a()}catch(e){b()}finally{c()}");
  });

  it("does NOT insert semicolon if next line starts with a ternary or optional chain", () => {
    const input =
      "var label = e.heading\n  ? esc(e.navLabel)\n  : esc(e.navLabel)";
    expect(minifyJs(input)).toBe(
      "var label=e.heading?esc(e.navLabel):esc(e.navLabel)",
    );

    const input2 = "foo\n  ?.bar()";
    expect(minifyJs(input2)).toBe("foo?.bar()");
  });

  it("does NOT insert semicolon if next line starts with a binary operator", () => {
    const inputPlus = "const a = b\n  + c";
    expect(minifyJs(inputPlus)).toBe("const a=b+c");

    const inputMinus = "const a = b\n  - c";
    expect(minifyJs(inputMinus)).toBe("const a=b-c");

    const inputMult = "const a = b\n  * c";
    expect(minifyJs(inputMult)).toBe("const a=b*c");

    const inputDiv = "const a = b/\n  c";
    expect(minifyJs(inputDiv)).toBe("const a=b/c");

    const inputLogicalAnd = "const a = b\n  && c";
    expect(minifyJs(inputLogicalAnd)).toBe("const a=b&&c");

    const inputLogicalOr = "const a = b\n  || c";
    expect(minifyJs(inputLogicalOr)).toBe("const a=b||c");
  });

  it("inserts semicolon before prefix ++ or -- operators on next line", () => {
    const inputPlusPlus = "foo()\n++x";
    expect(minifyJs(inputPlusPlus)).toBe("foo();++x");

    const inputMinusMinus = "foo()\n--x";
    expect(minifyJs(inputMinusMinus)).toBe("foo();--x");
  });

  it.each([
    ["let x = 2; const y = ++\nx; return y;", 3],
    ["let x = 2; const y = --\nx; return y;", 1],
    ["let x = 2; return ++\nx;", 3],
    ["let x = 2; return --\nx;", 1],
    ["let x = 2; ++\nx; return x;", 3],
    ["let x = 2; --\nx; return x;", 1],
    ["const obj = { value: 2 }; const y = ++\nobj.value; return y;", 3],
    ["const obj = { value: 2 }; const y = --\nobj.value; return y;", 1],
  ])(
    "keeps a prefix update attached to its next-line operand: %s",
    (source, expected) => {
      expect(new Function(source)()).toBe(expected);
      expect(new Function(minifyJs(source))()).toBe(expected);
    },
  );

  it.each([
    "let of = 2; of++\nreturn of;",
    "const obj = { return: 2 }; obj.return++\nreturn obj.return;",
    'const obj = { value: 2 }; obj["value"]++\nreturn obj.value;',
    "let value = 2; if (value) ++\nvalue; return value;",
    "let value = 2; if (false) value--; else ++\nvalue; return value;",
  ])(
    "preserves update context for identifiers, properties, and control headers: %s",
    (source) => {
      expect(new Function(minifyJs(source))()).toBe(new Function(source)());
    },
  );

  it("inserts semicolon after a line ending with postfix ++ or --", () => {
    // Postfix ++ and -- end a complete expression. Without a semicolon the next
    // token glues onto them and produces a syntax error (e.g. `x++foo()` or
    // `x++return x` or `do x++while(c)` which the parser rejects).
    expect(minifyJs("x++\nfoo()")).toBe("x++;foo()");
    expect(minifyJs("x--\nfoo()")).toBe("x--;foo()");
    expect(minifyJs("x++\nreturn x")).toBe("x++;return x");
    expect(minifyJs("do x++\nwhile (x < 10)")).toBe("do x++;while(x<10)");
    expect(minifyJs("do a[i]++\nwhile (i-- > 0)")).toBe(
      "do a[i]++;while(i-->0)",
    );
    // Postfix ++ in the middle of an expression (no newline) must not add semicolons.
    // Step 5 keeps a space before unary `+1` (to avoid `+++` being read as `++ +`),
    // and step 4 strips spaces around `>`.
    expect(minifyJs("x++ + 1")).toBe("x++ +1");
    expect(minifyJs("x++ > 0")).toBe("x++>0");
    // Prefix ++ starting the next line keeps its own semicolon-before rule
    expect(minifyJs("foo()\n++x")).toBe("foo();++x");
  });

  it("does not treat identifiers beginning with in as the in keyword", () => {
    expect(
      minifyJs("const value = fields[field]\ninput.setAttribute('x', 'y');"),
    ).toBe("const value=fields[field];input.setAttribute('x','y');");
  });
});

describe("minifyJs – word token and keyword boundaries", () => {
  it("preserves space between keyword and variable", () => {
    expect(minifyJs("let x = 1;")).toBe("let x=1;");
    expect(minifyJs("const y = 2;")).toBe("const y=2;");
    expect(minifyJs("var z = 3;")).toBe("var z=3;");
  });

  it("preserves space between typeof/instanceof/void/delete and operand", () => {
    expect(minifyJs("typeof x;")).toBe("typeof x;");
    expect(minifyJs("void 0;")).toBe("void 0;");
    expect(minifyJs("delete a.b;")).toBe("delete a.b;");
    expect(minifyJs("a instanceof B;")).toBe("a instanceof B;");
  });

  it("preserves space in import/export statements", () => {
    expect(minifyJs("import { a } from 'b';")).toBe("import{a}from'b';");
    expect(minifyJs("export default foo;")).toBe("export default foo;");
  });

  it("preserves space in class extends", () => {
    expect(minifyJs("class A extends B {}")).toBe("class A extends B{}");
  });
});

describe("minifyJs – operator disambiguation & number dot safety", () => {
  it("preserves necessary spaces for unary plus/minus and binary plus/minus", () => {
    expect(minifyJs("a + +b;")).toBe("a+ +b;");
    expect(minifyJs("a + ++b;")).toBe("a+ ++b;");
    expect(minifyJs("a - -b;")).toBe("a- -b;");
    expect(minifyJs("a - --b;")).toBe("a- --b;");
  });

  it("preserves space between integer literal and dot method call", () => {
    expect(minifyJs("1 .toString();")).toBe("1 .toString();");
    expect(minifyJs("1.5.toString();")).toBe("1.5.toString();");
    expect(minifyJs("(1).toString();")).toBe("(1).toString();");
  });
});

describe("minifyJs – real world IIFE and search script minification", () => {
  it("minifies an IIFE search function into a single line", () => {
    const input = `(function() {
      function tokens(q) {
        return q.split(/\\s+/).filter(function (w) { return w.length >= 2; });
      }
      function basePath(path) {
        return path.split('#')[0];
      }
    })();`;
    const minified = minifyJs(input);
    expect(minified).not.toContain("\n");
    expect(minified).toBe(
      "(function(){function tokens(q){return q.split(/\\s+/).filter(function(w){return w.length>=2;});};function basePath(path){return path.split('#')[0];}})();",
    );
  });
});

describe("minifyJs – property-based fuzzing", () => {
  it("does not throw on arbitrary strings and outputs valid string", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => minifyJs(input)).not.toThrow();
        const result = minifyJs(input);
        expect(typeof result).toBe("string");
      }),
      { numRuns: 200 },
    );
  });

  it("keeps braceless if/else bodies on their own lines valid JavaScript", () => {
    // Generates the shape Prettier writes for long conditions: header, then an indented body.
    const literal = fc.oneof(
      fc.constantFrom('"x"', "'y'", "`z`", "1", "a", "/r/.source"),
    );
    const condition = fc
      .tuple(literal, fc.constantFrom("===", "!==", "<", "&&"), literal)
      .map(([l, op, r]) => `${l} ${op} ${r}`);
    const statement = fc.constantFrom(
      "b = 1;",
      "f();",
      'g("s");',
      "o.p = `t`;",
    );
    fc.assert(
      fc.property(
        fc.constantFrom("if", "while"),
        condition,
        statement,
        statement,
        (keyword, cond, body, other) => {
          const source =
            keyword === "if"
              ? `if (${cond})\n  ${body}\nelse ${other}`
              : `while (${cond})\n  ${body}\n${other}`;
          const minified = minifyJs(source);
          expect(() => new Function(minified)).not.toThrow();
        },
      ),
      { numRuns: 300 },
    );
  });
});
