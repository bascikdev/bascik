/**
 * throw-non-error: a thrown or rejected value that can never be an Error has
 * no stack, so Bascik's runtime report can name only where the script
 * starts. The rule marks the line in the editor and in `bascik --check`.
 * These tests cover each form it reports, each form it must leave alone
 * (could be an Error, not a throw at all, words in strings and comments,
 * TypeScript members named throw), code being typed, the ranges in an .html
 * file, the files it applies to, suppression, and the quick fix.
 */
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";
import { createCodeActions, createDiagnostics } from "./analyzer.js";
import type { ProjectSnapshot } from "./project.js";
import {
  THROW_NON_ERROR_RULE,
  findNonErrorThrows,
  nonErrorThrowMessage,
} from "./throw-non-error.js";

/** Each finding as `site:value:[source text]`. */
const found = (source: string): string[] =>
  findNonErrorThrows(source).map(
    (f) => `${f.site}:${f.value}:[${source.slice(f.start, f.end)}]`,
  );

describe("findNonErrorThrows: values that can never be an Error", () => {
  it.each([
    ['throw "not found";', 'throw:a string:["not found"]'],
    ["throw 'not found'", "throw:a string:['not found']"],
    ["throw `no book ${id}`;", "throw:a string:[`no book ${id}`]"],
    ["throw `plain`;", "throw:a string:[`plain`]"],
    ["throw 404;", "throw:a number:[404]"],
    ["throw -1;", "throw:a number:[-1]"],
    ["throw .5;", "throw:a number:[.5]"],
    ["throw 10n;", "throw:a bigint:[10n]"],
    ["throw true;", "throw:a boolean:[true]"],
    ["throw null;", "throw:null:[null]"],
    ["throw undefined;", "throw:undefined:[undefined]"],
    ["throw void 0;", "throw:undefined:[void 0]"],
    ["throw /x/g;", "throw:a regular expression:[/x/g]"],
    ["throw { status: 404 };", "throw:an object:[{ status: 404 }]"],
    ["throw [1, 2];", "throw:an array:[[1, 2]]"],
    ["throw typeof x;", "throw:a string:[typeof x]"],
    ["throw !ok;", "throw:a boolean:[!ok]"],
    ["throw count++;", "throw:a number:[count++]"],
    [
      'throw "Book " + id + " not found";',
      'throw:a string:["Book " + id + " not found"]',
    ],
    ["throw a + b;", "throw:a string or a number:[a + b]"],
    ["throw a < b;", "throw:a boolean:[a < b]"],
    ["throw status * 2;", "throw:a number:[status * 2]"],
    ["throw ('x');", "throw:a string:[('x')]"],
    ["throw (err, 'x');", "throw:a string:[(err, 'x')]"],
    ["throw message = 'x';", "throw:a string:[message = 'x']"],
    ["throw ok ? 'yes' : null;", "throw:a string or null:[ok ? 'yes' : null]"],
    ["throw err && 'x';", "throw:a string:[err && 'x']"],
    ["throw null ?? 'x';", "throw:null or a string:[null ?? 'x']"],
    ["throw () => 1;", "throw:a function:[() => 1]"],
    ["throw function () {};", "throw:a function:[function () {}]"],
    // A cast changes no value: the string is still thrown.
    [
      'throw "x" as unknown as Error;',
      'throw:a string:["x" as unknown as Error]',
    ],
    ["throw ('x' as string);", "throw:a string:[('x' as string)]"],
    ['throw "x" as Foo[] as Error;', 'throw:a string:["x" as Foo[] as Error]'],
    [
      "throw 'x' as keyof typeof codes;",
      "throw:a string:['x' as keyof typeof codes]",
    ],
    [
      "throw 'x' as Map<string, () => void> satisfies object;",
      "throw:a string:['x' as Map<string, () => void> satisfies object]",
    ],
  ])("%s", (source, expected) => {
    expect(found(source)).toEqual([expected]);
  });

  it("Promise.reject() with such a value, or with none", () => {
    expect(found('return Promise.reject("not found");')).toEqual([
      'Promise.reject:a string:["not found"]',
    ]);
    expect(found("return Promise.reject();")).toEqual([
      "Promise.reject::[Promise.reject()]",
    ]);
    expect(found("await Promise.reject({ code: 1 });")).toEqual([
      "Promise.reject:an object:[{ code: 1 }]",
    ]);
    expect(found("p.then(() => Promise.reject(null))")).toEqual([
      "Promise.reject:null:[null]",
    ]);
    expect(found("Promise?.reject('x'); Promise.reject?.(1)")).toEqual([
      "Promise.reject:a string:['x']",
      "Promise.reject:a number:[1]",
    ]);
  });

  it("an executor's reject parameter called with such a value, or with none", () => {
    expect(
      found(
        "new Promise((resolve, reject) => { reject('x'); reject(); reject(undefined); });",
      ),
    ).toEqual([
      "reject:a string:['x']",
      "reject::[reject()]",
      "reject:undefined:[undefined]",
    ]);
    expect(found("new Promise((res, rej) => rej(404));")).toEqual([
      "reject:a number:[404]",
    ]);
    expect(
      found(
        "new Promise(function (res, rej) { setTimeout(() => rej('late'), 10); });",
      ),
    ).toEqual(["reject:a string:['late']"]);
    expect(
      found("new Promise(async (resolve, reject) => { reject({}) });"),
    ).toEqual(["reject:an object:[{}]"]);
    expect(
      found(
        "new Promise<void>((resolve: () => void, reject: (e: unknown) => void): void => { reject('x') });",
      ),
    ).toEqual(["reject:a string:['x']"]);
  });

  it("reports each throw of a script, in order", () => {
    expect(
      found(
        "switch (kind) {\n  case 1: throw 'one';\n  default: throw new Error('other');\n}\nif (!ok) throw null\nelse done();\n",
      ),
    ).toEqual(["throw:a string:['one']", "throw:null:[null]"]);
  });

  it("a template with holes is one value, ending at its closing backtick", () => {
    expect(found("throw `a ${x}\n`\nnext();")).toEqual([
      "throw:a string:[`a ${x}\n`]",
    ]);
    expect(found("throw `${a}` + `${b}`;")).toEqual([
      "throw:a string:[`${a}` + `${b}`]",
    ]);
    expect(found("throw `${`${inner}`}`;")).toEqual([
      "throw:a string:[`${`${inner}`}`]",
    ]);
  });

  it("an expression that continues on the next line is one value", () => {
    expect(found("throw 'Book '\n  + id;")).toEqual([
      "throw:a string:['Book '\n  + id]",
    ]);
  });
});

describe("findNonErrorThrows: values that could be an Error are left alone", () => {
  it.each([
    "throw err;",
    "throw error;",
    "throw new Error('not found');",
    "throw new Error;",
    "throw new HttpError(404, 'not found');",
    "throw new errors.NotFound();",
    "throw new (pick())();",
    "throw Error('x');",
    "throw makeError('x');",
    "throw createError<HttpError>('x');",
    "throw err.cause;",
    "throw errors[0];",
    "throw await failure;",
    "throw tag`x`;",
    "throw err as Error;",
    "throw err!;",
    "throw this;",
    "throw ok ? 'fine' : new Error('x');",
    "throw err || 'fallback';",
    "throw err ?? null;",
    "throw ('x', err);",
    "throw (err);",
    "throw last = err;",
    "throw cached ||= new Error('x');",
    "try { run(); } catch (e) { log(e); throw e; }",
    "function* g() { throw yield; }",
    "Promise.reject(new Error('x'));",
    "Promise.reject(err);",
    "Promise.reject(...reasons);",
    "Promise.reject(makeError());",
    "globalThis.Promise.reject('x');",
    "new Promise((resolve) => resolve('x'));",
    "new Promise((resolve, reject) => reject(new Error('x')));",
    "new Promise((resolve, reject) => setTimeout(reject, 10));",
    "new Promise((resolve, reject) => stream.on('error', reject));",
    "new Foo.Promise((resolve, reject) => reject('x'));",
  ])("%s", (source) => {
    expect(found(source)).toEqual([]);
  });

  it("a reject name the executor's body declares again is not the parameter", () => {
    for (const source of [
      "new Promise((res, rej) => { const f = (rej) => rej('x'); });",
      "new Promise((res, rej) => { try {} catch (rej) { rej('x'); } });",
      "new Promise((res, rej) => { function rej() {} rej('x'); });",
      "new Promise((res, rej) => { const { rej } = o; rej('x'); });",
      "new Promise((res, rej) => { rej = wrap(rej); rej('x'); });",
      "new Promise((res, rej = noop) => rej('x'));",
      "new Promise((res, ...rej) => rej('x'));",
      "new Promise((res, { rej }) => rej('x'));",
    ])
      expect(found(source), source).toEqual([]);
  });
});

describe("findNonErrorThrows: throw that is not a throw statement", () => {
  it.each([
    ["a generator's throw() method", "gen.throw('stop');"],
    ["an optional call of it", "gen?.throw('stop');"],
    ["a property named throw", "obj.throw = 1; const o = { throw: 1 };"],
    [
      "class members named throw",
      "class A { throw = 1; static throw(x) {} get throw() { return 1; } *throw(e) {} async throw() {} #throw() {} throw!: string }",
    ],
    [
      "object methods named throw",
      "const o = { throw(x) { return x; }, async throw() {} };",
    ],
    [
      "TypeScript members named throw",
      "type T = { throw: string; throw?(): void }; interface I { throw(): void; throw(x: string): never } abstract class B { abstract throw(): void; }",
    ],
    ["a field named throw before a method", "class B { throw\n  foo() {} }"],
    [
      "names that start with throw",
      "x = y / throwCount; throwIt('x'); const throw_ = 'x';",
    ],
    [
      "throw in strings and comments",
      "const s = 'throw \"x\"'; // throw 'y'\n/* throw 1; Promise.reject() */ const d = \"Promise.reject('x')\";",
    ],
    [
      "throw in a template's text",
      "const t = `throw 'x' and Promise.reject()`;",
    ],
    [
      "throw in a regular expression",
      "const r = /throw 'x'/; const q = /Promise.reject\\(\\)/;",
    ],
  ])("%s", (_label, source) => {
    expect(found(source)).toEqual([]);
  });

  it("a throw inside a template's hole is still code", () => {
    expect(found("const t = `${(() => { throw 'x'; })()}`;")).toEqual([
      "throw:a string:['x']",
    ]);
  });
});

describe("findNonErrorThrows: code being typed reports nothing it cannot read", () => {
  it.each([
    "throw",
    "throw ",
    'throw "not found',
    "throw `no book ${",
    "throw `no book",
    "throw (",
    "throw {",
    "throw [1,",
    "throw 'a' 'b'",
    "throw <any>'x';",
    "Promise.reject(",
    "Promise.reject('x'",
    "new Promise(",
    "new Promise((resolve, reject",
    "new Promise((resolve, reject) => { reject('x'",
    "throw 'a' +",
    "throw ok ? 'a'",
  ])("%s", (source) => {
    expect(() => found(source)).not.toThrow();
    expect(found(source)).toEqual([]);
  });

  it("misuse: nesting deeper than the parser reads is skipped, not a stack overflow", () => {
    const deep = `throw ${"(".repeat(20_000)}"x"${")".repeat(20_000)};`;
    expect(() => found(deep)).not.toThrow();
    expect(found(deep)).toEqual([]);
    expect(found(`throw ${"!".repeat(20_000)}x;`)).toEqual([]);
    // A shallow one is still read.
    expect(found('throw ((("x")));')).toEqual(['throw:a string:[((("x")))]']);
  });
});

describe("nonErrorThrowMessage", () => {
  const messageOf = (source: string): string => {
    const [first] = findNonErrorThrows(source);
    return nonErrorThrowMessage(first, source.slice(first.start, first.end));
  };

  it("shows the string as an Error's message", () => {
    expect(messageOf('throw "not found";')).toBe(
      `Throw an Error, not a string: throw new Error("not found"). Only an Error carries a stack trace, so without one Bascik's error report cannot name this line.`,
    );
  });

  it("uses a placeholder for other values, and for a long or multi-line string", () => {
    expect(messageOf("throw null;")).toContain(
      'Throw an Error, not null: throw new Error("...").',
    );
    expect(messageOf("throw { status: 404 };")).toContain(
      "Throw an Error, not an object:",
    );
    expect(messageOf(`throw "${"x".repeat(80)}";`)).toContain(
      'throw new Error("...")',
    );
    expect(messageOf("throw `a\nb`;")).toContain('throw new Error("...")');
  });

  it("names the call a rejection goes through", () => {
    expect(messageOf("Promise.reject('gone');")).toBe(
      `Reject with an Error, not a string: Promise.reject(new Error('gone')). Only an Error carries a stack trace, so without one Bascik's error report cannot name this line.`,
    );
    expect(messageOf("Promise.reject();")).toBe(
      `Pass Promise.reject() an Error: Promise.reject(new Error("...")). A rejection with no reason has no stack trace, so Bascik's error report cannot name this line.`,
    );
    expect(messageOf("new Promise((ok, fail) => fail());")).toContain(
      'Pass fail() an Error: fail(new Error("...")).',
    );
    expect(messageOf("new Promise((ok, fail) => fail(7));")).toContain(
      "Reject with an Error, not a number: fail(new Error(",
    );
  });
});

const snapshot = (): ProjectSnapshot => ({
  projectRoot: "/site",
  componentRoots: ["/site/src/components"],
  apiRoot: "/site/src/api",
  componentMap: new Map(),
  componentMetadata: new Map(),
  importRoot: "/site/src",
  htmlUsageByFile: new Map(),
});

const diagnosticsFor = (
  path: string,
  languageId: string,
  text: string,
): Diagnostic[] =>
  createDiagnostics(
    TextDocument.create(`file://${path}`, languageId, 1, text),
    path,
    snapshot(),
  ).filter((d) => d.code === THROW_NON_ERROR_RULE);

const serverPage = (statement: string, directive = "data-bascik-server") =>
  [
    "<main>",
    "  <p>Books</p>",
    `  <script ${directive}>`,
    "    export default async () => {",
    `      ${statement}`,
    "      return '<p>ok</p>';",
    "    };",
    "  </script>",
    "</main>",
  ].join("\n");

describe("throw-non-error in the editor", () => {
  it("warns on the value, at its line and column in the .html file", () => {
    const [warning, ...rest] = diagnosticsFor(
      "/site/src/pages/books.html",
      "html",
      serverPage('throw "not found";'),
    );
    expect(rest).toEqual([]);
    expect(warning.severity).toBe(DiagnosticSeverity.Warning);
    expect(warning.source).toBe("bascik");
    expect(warning.range).toEqual({
      start: { line: 4, character: 12 },
      end: { line: 4, character: 23 },
    });
    expect(warning.message).toContain('throw new Error("not found")');
  });

  it("keeps the range right with CRLF line endings", () => {
    const [warning] = diagnosticsFor(
      "/site/src/pages/books.html",
      "html",
      serverPage("return Promise.reject();").replace(/\n/g, "\r\n"),
    );
    expect(warning.range).toEqual({
      start: { line: 4, character: 13 },
      end: { line: 4, character: 29 },
    });
  });

  it("applies to every directive script: server, stream, build, build-once and routes", () => {
    for (const directive of [
      "data-bascik-server",
      "data-bascik-stream",
      "data-bascik-build",
      "data-bascik-build-once",
      "data-bascik-routes",
    ])
      expect(
        diagnosticsFor(
          "/site/src/components/book-list.html",
          "html",
          serverPage("throw null;", directive),
        ),
        directive,
      ).toHaveLength(1);
  });

  it("checks a TypeScript directive script too", () => {
    expect(
      diagnosticsFor(
        "/site/src/pages/books.html",
        "html",
        serverPage("throw 'x' as unknown;").replace(
          "<script data-bascik-server>",
          '<script data-bascik-server type="text/typescript">',
        ),
      ),
    ).toHaveLength(1);
  });

  it("leaves browser scripts, a src= directive script's empty body and markup alone", () => {
    const page = [
      "<main>",
      '  <p>throw "in the text"</p>',
      '  <script>throw "browser";</script>',
      '  <script type="module">Promise.reject("browser");</script>',
      '  <script data-bascik-server src="./books.ts"></script>',
      "</main>",
    ].join("\n");
    expect(diagnosticsFor("/site/src/pages/books.html", "html", page)).toEqual(
      [],
    );
  });

  it("warns in an API route, a .ts file that runs in Node", () => {
    const route = [
      "export const GET = async (request: Request) => {",
      "  const id = new URL(request.url).searchParams.get('id');",
      "  if (!id) throw { status: 400 };",
      "  return Response.json({ id });",
      "};",
    ].join("\n");
    const [warning] = diagnosticsFor(
      "/site/src/api/books.ts",
      "typescript",
      route,
    );
    expect(warning.range).toEqual({
      start: { line: 2, character: 17 },
      end: { line: 2, character: 32 },
    });
    expect(warning.message).toContain("Throw an Error, not an object");
  });

  it("is silenced by bascik-ignore on the line above, and by disabledRules", () => {
    const ignored = serverPage(
      '// bascik-ignore throw-non-error\n      throw "not found";',
    );
    expect(
      diagnosticsFor("/site/src/pages/books.html", "html", ignored),
    ).toEqual([]);
    // A typo'd rule id silences nothing.
    expect(
      diagnosticsFor(
        "/site/src/pages/books.html",
        "html",
        ignored.replace("throw-non-error", "throw-non-errors"),
      ),
    ).toHaveLength(1);
  });
});

describe("throw-non-error quick fix", () => {
  const actionsFor = (text: string) => {
    const document = TextDocument.create(
      "file:///site/src/pages/books.html",
      "html",
      1,
      text,
    );
    const diagnostics = createDiagnostics(
      document,
      "/site/src/pages/books.html",
      snapshot(),
    ).filter((d) => d.code === THROW_NON_ERROR_RULE);
    const actions = createCodeActions(
      document,
      diagnostics[0].range,
      diagnostics,
      snapshot(),
      "/site/src/pages/books.html",
    );
    const apply = (index: number): string => {
      const edits = Object.values(actions[index].edit!.changes!)[0];
      return TextDocument.applyEdits(document, edits);
    };
    return { actions, apply };
  };

  it("wraps a thrown string in new Error(...), keeping its text", () => {
    const { actions, apply } = actionsFor(serverPage('throw "not found";'));
    expect(actions.map((a) => a.title)).toEqual(["Wrap in new Error(...)"]);
    expect(actions[0].isPreferred).toBe(true);
    expect(apply(0)).toBe(serverPage('throw new Error("not found");'));
  });

  it("wraps a template literal and a rejected string", () => {
    expect(actionsFor(serverPage("throw `no book ${id}`;")).apply(0)).toBe(
      serverPage("throw new Error(`no book ${id}`);"),
    );
    expect(
      actionsFor(serverPage("return Promise.reject('gone');")).apply(0),
    ).toBe(serverPage("return Promise.reject(new Error('gone'));"));
  });

  it("offers no fix where wrapping would not keep the value's meaning", () => {
    for (const statement of [
      "throw null;",
      "throw { status: 404 };",
      "throw 'Book ' + id;",
      "return Promise.reject();",
    ])
      expect(actionsFor(serverPage(statement)).actions, statement).toEqual([]);
  });
});
