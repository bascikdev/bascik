import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { minifyJs } from "./js-minifier.ts";

describe("minifyJs – basic comment stripping and whitespace collapsing", () => {
  it("removes block comments", () => {
    expect(minifyJs("/* hello */var x = 1;")).toBe("var x=1;");
  });

  it("removes line comments", () => {
    expect(minifyJs("var x = 1; // comment\nvar y = 2;")).toBe("var x=1;var y=2;");
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
    expect(minifyJs("var s = `he said \\`hi\\``;")).toBe("var s=`he said \\`hi\\``;");
  });

  it("handles escape sequences in strings", () => {
    expect(minifyJs('var s = "he said \\"hi\\"";')).toBe(
      'var s="he said \\"hi\\"";',
    );
  });

  it("preserves template literals with interpolated expressions", () => {
    expect(minifyJs("var s = `sum is ${a + b}`;")).toBe("var s=`sum is ${a + b}`;");
  });
});

describe("minifyJs – regex literal handling", () => {
  it("preserves a simple regex literal verbatim", () => {
    expect(minifyJs("var re = /abc/g;")).toBe("var re=/abc/g;");
  });

  it("preserves a regex literal with flags", () => {
    expect(minifyJs("var re = /hello world/gi;")).toBe("var re=/hello world/gi;");
  });

  it("does not confuse '/' in a character class with the closing delimiter", () => {
    expect(minifyJs("var re = /[/]/;")).toBe("var re=/[/]/;");
  });

  it("preserves a regex with escape sequences", () => {
    expect(minifyJs("var re = /a\\/b/;")).toBe("var re=/a\\/b/;");
  });

  it("treats '/' as division when regex is unterminated before newline", () => {
    const result = minifyJs("var n = /foo\n/bar;");
    expect(result).toBe("var n=/foo;/bar;");
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

  it("handles try-catch-finally blocks correctly", () => {
    const input = "try {\n  a()\n} catch (e) {\n  b()\n} finally {\n  c()\n}";
    expect(minifyJs(input)).toBe("try{a()}catch(e){b()}finally{c()}");
  });

  it("does NOT insert semicolon if next line starts with a ternary or optional chain", () => {
    const input = "var label = e.heading\n  ? esc(e.navLabel)\n  : esc(e.navLabel)";
    expect(minifyJs(input)).toBe("var label=e.heading?esc(e.navLabel):esc(e.navLabel)");

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
});
