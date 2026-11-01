import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";
import { INITIAL, parseRawGrammar, Registry } from "vscode-textmate";
import type { IGrammar } from "vscode-textmate";

const grammarPath = join(__dirname, "../syntaxes/bascik-html.tmLanguage.json");
const manifestPath = join(__dirname, "../package.json");

interface InjectionGrammar {
  scopeName: string;
  injectionSelector: string;
  patterns: {
    begin?: string;
    match?: string;
    end?: string;
    patterns?: { include: string }[];
  }[];
}

const readGrammar = async (): Promise<InjectionGrammar> =>
  JSON.parse(await readFile(grammarPath, "utf8")) as InjectionGrammar;

const attributePattern = async (): Promise<RegExp> => {
  const [rule] = (await readGrammar()).patterns;
  return new RegExp(rule.begin ?? rule.match ?? "", "g");
};

/**
 * The root grammar VS Code tokenizes the `html` language with. Since VS Code 1.52 the built-in HTML
 * extension maps `language: html` to `text.html.derivative`; `text.html.basic` has no language of its own.
 */
const HTML_LANGUAGE_ROOT_SCOPE = "text.html.derivative";

/**
 * VS Code's TMGrammarFactory loads, for a root scope, the injections registered under every dot prefix of
 * it (`text`, `text.html`, `text.html.derivative`), and only those.
 */
function injectionsFor(
  rootScope: string,
  grammars: { scopeName: string; injectTo?: string[] }[],
): string[] {
  const parts = rootScope.split(".");
  const prefixes = parts.map((_, index) => parts.slice(0, index + 1).join("."));
  return grammars
    .filter((grammar) =>
      grammar.injectTo?.some((scope) => prefixes.includes(scope)),
    )
    .map((grammar) => grammar.scopeName);
}

/** TextMate scope matching: a selector scope matches a scope equal to it or starting with it plus a dot. */
const scopeMatches = (selector: string, scope: string): boolean =>
  scope === selector || scope.startsWith(`${selector}.`);

/**
 * The subset of TextMate selector syntax the grammar uses: an optional `L:` priority, then scopes that must
 * appear in order in the stack, then `-scope` exclusions that must not appear anywhere in it.
 */
function selectorMatches(selector: string, scopeStack: string[]): boolean {
  const terms = selector
    .replace(/^[LR]:/, "")
    .trim()
    .split(/\s+/);
  const required = terms.filter((term) => !term.startsWith("-"));
  const excluded = terms
    .filter((term) => term.startsWith("-"))
    .map((term) => term.slice(1));
  if (
    excluded.some((term) =>
      scopeStack.some((scope) => scopeMatches(term, scope)),
    )
  ) {
    return false;
  }
  let position = 0;
  for (const term of required) {
    while (
      position < scopeStack.length &&
      !scopeMatches(term, scopeStack[position])
    ) {
      position++;
    }
    if (position === scopeStack.length) return false;
    position++;
  }
  return true;
}

describe("Bascik HTML grammar", () => {
  it.each([
    "data-bascik-build",
    "data-bascik-build-once",
    "data-bascik-routes",
    "data-bascik-server",
    "data-bascik-stream",
    "data-bascik-preserve",
    "data-bascik-slot",
    "data-bascik-prop-title",
    "data-bascik-attr-href",
  ])("highlights the whole %s attribute name", async (name) => {
    const matches = `<script ${name}>`.match(await attributePattern());
    expect(matches).toEqual([name]);
  });

  it.each([
    "data-bascik-build-later",
    "data-bascik-slotted",
    "data-bascik-server:x",
    "data-bascik-text",
    "data-bascik-html",
  ])("leaves the unknown %s attribute to the HTML grammar", async (name) => {
    expect(`<div ${name}>`.match(await attributePattern())).toBeNull();
  });

  it("is loaded for documents in the html language", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      contributes: { grammars: { scopeName: string; injectTo?: string[] }[] };
    };
    const { scopeName } = await readGrammar();
    expect(
      injectionsFor(HTML_LANGUAGE_ROOT_SCOPE, manifest.contributes.grammars),
    ).toContain(scopeName);
  });

  it.each([
    [
      "an attribute in a start tag",
      [HTML_LANGUAGE_ROOT_SCOPE, "meta.tag.structure.div.start.html"],
    ],
    [
      "an attribute in a custom element tag",
      [HTML_LANGUAGE_ROOT_SCOPE, "meta.tag.custom.start.html"],
    ],
    [
      "an attribute on a script tag",
      [
        HTML_LANGUAGE_ROOT_SCOPE,
        "meta.embedded.block.html",
        "meta.tag.metadata.script.start.html",
      ],
    ],
  ])("applies to %s", async (_label, scopeStack) => {
    const { injectionSelector } = await readGrammar();
    expect(selectorMatches(injectionSelector, scopeStack)).toBe(true);
  });

  it.each([
    ["body text", [HTML_LANGUAGE_ROOT_SCOPE]],
    ["a comment", [HTML_LANGUAGE_ROOT_SCOPE, "comment.block.html"]],
    [
      "another attribute's value",
      [
        HTML_LANGUAGE_ROOT_SCOPE,
        "meta.tag.structure.div.start.html",
        "meta.attribute.class.html",
        "string.quoted.double.html",
      ],
    ],
    [
      "a string in an inline script",
      [
        HTML_LANGUAGE_ROOT_SCOPE,
        "meta.embedded.block.html",
        "source.js",
        "string.quoted.single.js",
      ],
    ],
    [
      "a selector in an inline style",
      [HTML_LANGUAGE_ROOT_SCOPE, "meta.embedded.block.html", "source.css"],
    ],
  ])("does not apply to %s", async (_label, scopeStack) => {
    const { injectionSelector } = await readGrammar();
    expect(selectorMatches(injectionSelector, scopeStack)).toBe(false);
  });

  it("keeps the attribute value highlighted as an HTML attribute value", async () => {
    // A bare `match` consumes only the name, and the HTML grammar then marks `="x"` as an illegal character.
    const [rule] = (await readGrammar()).patterns;
    expect(rule.match).toBeUndefined();
    expect(rule.end).toBeDefined();
    expect(rule.patterns).toEqual([
      { include: "text.html.basic#attribute-interior" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// TypeScript in <script type="text/typescript">
//
// These tests tokenize real documents with vscode-textmate (the engine VS Code runs) and the grammars VS Code ships
// for HTML, JavaScript, CSS and TypeScript (from tm-grammars), with the injections this manifest registers for the
// `html` language's root scope. VS Code's HTML grammar colors a script as JavaScript only for JavaScript types and
// leaves `type="text/typescript"` as `source.unknown`; the injection embeds VS Code's own TypeScript grammar there.
// ---------------------------------------------------------------------------------------------------------------

interface ManifestGrammar {
  scopeName: string;
  path: string;
  injectTo?: string[];
  embeddedLanguages?: Record<string, string>;
}

const readManifestGrammars = async (): Promise<ManifestGrammar[]> =>
  (
    JSON.parse(await readFile(manifestPath, "utf8")) as {
      contributes: { grammars: ManifestGrammar[] };
    }
  ).contributes.grammars;

const resolveFromHere = createRequire(__filename).resolve;

/** The grammars VS Code itself registers for these scopes. */
const BUILT_IN_GRAMMAR_FILES: Record<string, string> = {
  "text.html.derivative": "tm-grammars/grammars/html-derivative.json",
  "text.html.basic": "tm-grammars/grammars/html.json",
  "source.ts": "tm-grammars/grammars/typescript.json",
  "source.js": "tm-grammars/grammars/javascript.json",
  "source.css": "tm-grammars/grammars/css.json",
};

let htmlGrammar: Promise<IGrammar> | undefined;

async function loadHtmlGrammar(): Promise<IGrammar> {
  const wasm = await readFile(
    resolveFromHere("vscode-oniguruma/release/onig.wasm"),
  );
  await loadWASM(
    wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
  );
  const manifestGrammars = await readManifestGrammars();
  const ownGrammarFiles = new Map(
    manifestGrammars.map((grammar) => [
      grammar.scopeName,
      join(__dirname, "..", grammar.path),
    ]),
  );
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns: string[]) => new OnigScanner(patterns),
      createOnigString: (text: string) => new OnigString(text),
    }),
    loadGrammar: async (scopeName) => {
      const file =
        ownGrammarFiles.get(scopeName) ??
        (BUILT_IN_GRAMMAR_FILES[scopeName] &&
          resolveFromHere(BUILT_IN_GRAMMAR_FILES[scopeName]));
      if (!file) return null;
      return parseRawGrammar(await readFile(file, "utf8"), file);
    },
    getInjections: (scopeName) =>
      injectionsFor(scopeName, manifestGrammars).filter(
        // VS Code applies the prefix rule only to the root grammar it was asked for.
        () => scopeName === HTML_LANGUAGE_ROOT_SCOPE,
      ),
  });
  const grammar = await registry.loadGrammar(HTML_LANGUAGE_ROOT_SCOPE);
  if (!grammar) throw new Error("The HTML grammar did not load");
  return grammar;
}

interface Token {
  text: string;
  scopes: string[];
  line: number;
}

/** Tokenizes `source` line by line, as VS Code does, keeping the grammar state between lines. */
async function tokenize(source: string): Promise<Token[]> {
  htmlGrammar ??= loadHtmlGrammar();
  const grammar = await htmlGrammar;
  const tokens: Token[] = [];
  let state = INITIAL;
  source.split("\n").forEach((lineText, line) => {
    const result = grammar.tokenizeLine(lineText, state);
    for (const token of result.tokens) {
      const text = lineText.slice(token.startIndex, token.endIndex);
      if (text.length > 0) tokens.push({ text, scopes: token.scopes, line });
    }
    state = result.ruleStack;
  });
  return tokens;
}

function tokenFor(tokens: Token[], text: string, occurrence = 0): Token {
  const found = tokens.filter((token) => token.text.trim() === text);
  const token = found[occurrence];
  if (!token) {
    throw new Error(
      `No token "${text}" (#${occurrence}) in ${JSON.stringify(tokens.map((t) => t.text))}`,
    );
  }
  return token;
}

const isTypeScript = (token: Token): boolean =>
  token.scopes.includes("source.ts");
const isInScript = (token: Token): boolean =>
  token.scopes.some((scope) => /^source\./.test(scope));

/** The embedded languages VS Code merges into the root grammar: those of injections whose injectTo is that exact scope. */
function embeddedLanguagesFor(
  rootScope: string,
  grammars: ManifestGrammar[],
): Record<string, string> {
  return Object.assign(
    {},
    ...grammars
      .filter((grammar) => grammar.injectTo?.includes(rootScope))
      .map((grammar) => grammar.embeddedLanguages ?? {}),
  ) as Record<string, string>;
}

/** Bascik pages and components as authors write them, Prettier-formatted. */
const TYPESCRIPT_SCRIPTS: [string, string][] = [
  [
    "a bare type attribute",
    '<script type="text/typescript">\n  const count: number = 1;\n</script>',
  ],
  [
    "a build directive before the type",
    '<script data-bascik-build type="text/typescript">\n  const count: number = 1;\n</script>',
  ],
  [
    "a server directive after the type",
    '<script type="text/typescript" data-bascik-server>\n  const count: number = 1;\n</script>',
  ],
  [
    "single quotes",
    "<script type='text/typescript'>\n  const count: number = 1;\n</script>",
  ],
  [
    "an unquoted value",
    "<script type=text/typescript>\n  const count: number = 1;\n</script>",
  ],
  [
    "an unquoted value followed by another attribute",
    "<script type=text/typescript data-bascik-stream>\n  const count: number = 1;\n</script>",
  ],
  [
    "upper case, as HTML attribute names and MIME types are case-insensitive",
    '<SCRIPT TYPE="Text/TypeScript">\n  const count: number = 1;\n</SCRIPT>',
  ],
  [
    "spaces around = and inside the quotes, which Bascik trims",
    '<script type = " text/typescript ">\n  const count: number = 1;\n</script>',
  ],
  [
    "a Prettier-wrapped open tag with > on its own line",
    '<script\n  data-bascik-routes\n  type="text/typescript"\n  data-bascik-build-once\n>\n  const count: number = 1;\n</script>',
  ],
  [
    "the type first in a wrapped open tag",
    '<script\n  type="text/typescript"\n  data-bascik-build\n>\n  const count: number = 1;\n</script>',
  ],
  [
    "the code on the same line as the tags",
    '<script type="text/typescript">const count: number = 1;</script>',
  ],
  [
    "a type attribute and an unrelated data-type attribute",
    '<script data-type="text/plain" type="text/typescript">\n  const count: number = 1;\n</script>',
  ],
];

describe("TypeScript in type=text/typescript scripts", () => {
  it("registers an html injection that maps the embedded TypeScript to the typescript language", async () => {
    const grammars = await readManifestGrammars();
    const embedding = grammars.find(
      (grammar) => grammar.embeddedLanguages?.["source.ts"] === "typescript",
    );
    expect(embedding).toBeDefined();
    // VS Code loads an injection for every dot prefix of the root scope, but merges an injection's
    // embeddedLanguages only when injectTo names the root scope itself (TMGrammarFactory.createGrammar), so
    // `text.html` alone would color the block while comment toggling still used HTML comments.
    expect(
      embeddedLanguagesFor(HTML_LANGUAGE_ROOT_SCOPE, grammars)["source.ts"],
    ).toBe("typescript");
    expect(injectionsFor(HTML_LANGUAGE_ROOT_SCOPE, grammars)).toContain(
      embedding?.scopeName,
    );
  });

  it.each(TYPESCRIPT_SCRIPTS)(
    "colors the block as TypeScript with %s",
    async (_label, source) => {
      const tokens = await tokenize(source);
      const annotation = tokenFor(tokens, "number");
      expect(annotation.scopes).toContain("source.ts");
      expect(annotation.scopes).toContain("support.type.primitive.ts");
      expect(tokenFor(tokens, "const").scopes).toContain("storage.type.ts");
      expect(annotation.scopes).toContain("meta.embedded.block.html");
      expect(annotation.scopes).not.toContain("source.unknown");
      // The tags themselves stay HTML.
      for (const token of tokens.filter((t) => /^script$/i.test(t.text))) {
        expect(token.scopes).toContain("entity.name.tag.html");
        expect(isTypeScript(token)).toBe(false);
      }
      expect(
        tokens.some((token) =>
          token.scopes.some((scope) => scope.includes("invalid.illegal")),
        ),
      ).toBe(false);
    },
  );

  it("keeps Bascik attribute names and the type value colored as HTML on the tag", async () => {
    const tokens = await tokenize(
      '<script\n  data-bascik-server\n  type="text/typescript"\n  data-bascik-stream\n>\n  export default () => 1;\n</script>',
    );
    for (const name of ["data-bascik-server", "data-bascik-stream"]) {
      const token = tokenFor(tokens, name);
      expect(token.scopes).toContain("entity.other.attribute-name.bascik");
      expect(isTypeScript(token)).toBe(false);
    }
    const value = tokenFor(tokens, "text/typescript");
    expect(value.scopes).toContain("string.quoted.double.html");
    expect(value.scopes).toContain("meta.tag.metadata.script.start.html");
    expect(isTypeScript(value)).toBe(false);
    expect(tokenFor(tokens, ">").scopes).toContain(
      "punctuation.definition.tag.end.html",
    );
  });

  it("colors a build script's imports, types and export default as TypeScript", async () => {
    const tokens = await tokenize(
      [
        '<script type="text/typescript" data-bascik-build>',
        '  import { seo } from "@/lib/seo.ts";',
        '  import type { Product } from "./product.ts";',
        "",
        "  interface Frother {",
        "    name: string;",
        "  }",
        "",
        "  export default async function (): Promise<string> {",
        '    const frother: Frother = { name: "Milk frother" };',
        "    return seo(frother.name);",
        "  }",
        "</script>",
        "<p>After</p>",
      ].join("\n"),
    );
    expect(tokenFor(tokens, "import").scopes).toContain(
      "keyword.control.import.ts",
    );
    // The first `type` is the HTML attribute on the tag; the second is `import type`.
    expect(tokenFor(tokens, "type", 1).scopes).toContain(
      "keyword.control.type.ts",
    );
    expect(tokenFor(tokens, "interface").scopes).toContain(
      "storage.type.interface.ts",
    );
    expect(tokenFor(tokens, "Frother").scopes).toContain(
      "entity.name.type.interface.ts",
    );
    expect(tokenFor(tokens, "export").scopes).toContain(
      "keyword.control.export.ts",
    );
    expect(tokenFor(tokens, "@/lib/seo.ts").scopes).toContain(
      "string.quoted.double.ts",
    );
    // The document goes back to HTML after the block.
    const after = tokenFor(tokens, "p");
    expect(after.scopes).toContain("entity.name.tag.html");
    expect(isInScript(after)).toBe(false);
  });

  it.each([
    ["no type", "<script>\n  const count = 1;\n</script>"],
    ["type=module", '<script type="module">\n  const count = 1;\n</script>'],
    [
      "type=text/javascript",
      '<script type="text/javascript" data-bascik-build>\n  const count = 1;\n</script>',
    ],
  ])(
    "leaves a JavaScript script with %s as JavaScript",
    async (_label, source) => {
      const token = tokenFor(await tokenize(source), "const");
      expect(token.scopes).toContain("source.js");
      expect(isTypeScript(token)).toBe(false);
    },
  );

  it.each([
    ["a typo in the type", '<script type="text/typscript">'],
    ["a longer type", '<script type="text/typescriptx">'],
    ["a type with a trailing slash", "<script type=text/typescript/>"],
    [
      "application/typescript, which Bascik does not strip",
      '<script type="application/typescript">',
    ],
    ["an empty type", '<script type="">'],
    [
      "the TypeScript type on another attribute",
      '<script data-type="text/typescript" type="text/plain">',
    ],
    ["a JSON block", '<script type="application/json">'],
    ["an import map", '<script type="importmap">'],
  ])("leaves the block alone with %s", async (_label, openTag) => {
    const tokens = await tokenize(
      `${openTag}\n  const count: number = 1;\n</script>\n<p>After</p>`,
    );
    expect(tokens.some(isTypeScript)).toBe(false);
    const after = tokenFor(tokens, "p");
    expect(after.scopes).toContain("entity.name.tag.html");
    expect(isInScript(after)).toBe(false);
  });

  it("leaves an HTML template script as HTML", async () => {
    const tokens = await tokenize(
      '<script type="text/html">\n  <p>Template</p>\n</script>',
    );
    expect(tokens.some(isTypeScript)).toBe(false);
    expect(tokenFor(tokens, "p").scopes).toContain("entity.name.tag.html");
  });

  it.each([
    ["body text", '<p>type="text/typescript" const n: number = 1;</p>'],
    [
      "an HTML comment",
      '<!-- <script type="text/typescript"> const n: number = 1; -->',
    ],
    [
      "an attribute value",
      "<div title='type=\"text/typescript\"'>const n: number = 1;</div>",
    ],
    [
      "a style block",
      '<style type="text/typescript">\n  p { color: red; }\n</style>',
    ],
    [
      "a style block whose CSS starts with the type",
      "<style>type=text/typescript\n</style>",
    ],
  ])("does not start TypeScript in %s", async (_label, source) => {
    expect((await tokenize(source)).some(isTypeScript)).toBe(false);
  });

  it("keeps a CSS block after a TypeScript block as CSS", async () => {
    const tokens = await tokenize(
      '<script type="text/typescript">\n  let open: boolean = false;\n</script>\n<style>\n  p { color: red; }\n</style>',
    );
    expect(tokenFor(tokens, "color").scopes).toContain("source.css");
    expect(isTypeScript(tokenFor(tokens, "color"))).toBe(false);
  });

  it("colors several TypeScript blocks in one file independently", async () => {
    const tokens = await tokenize(
      [
        '<script type="text/typescript" data-bascik-server>',
        "  export default (): string => 'a';",
        "</script>",
        "<p>Between</p>",
        '<script type="text/typescript">',
        "  let open: boolean = false;",
        "</script>",
      ].join("\n"),
    );
    expect(isInScript(tokenFor(tokens, "p"))).toBe(false);
    expect(isTypeScript(tokenFor(tokens, "string"))).toBe(true);
    expect(isTypeScript(tokenFor(tokens, "boolean"))).toBe(true);
  });

  it("keeps the rest of the file TypeScript when the closing tag is missing, without errors", async () => {
    const tokens = await tokenize(
      '<script type="text/typescript">\n  let open: boolean = false;\n<p>never closed</p>\n',
    );
    expect(isTypeScript(tokenFor(tokens, "boolean"))).toBe(true);
    expect(isTypeScript(tokenFor(tokens, "never"))).toBe(true);
  });

  // An HTML parser ends a script at the first `</script`, wherever it is. VS Code's JavaScript embedding ends a
  // comment there but lets a string run over it; the TypeScript embedding must agree with it in both cases.
  it.each([
    ["a line comment", "  // see </script> for details"],
    ["a block comment", "  /* see </script> */"],
    ["an unclosed block comment", "  /* see </script>"],
    ["a double-quoted string", '  const tag = "</script>";'],
    ["a template literal", "  const tag = `</script>`;"],
  ])(
    "ends the block where VS Code's JavaScript does with </script> in %s",
    async (_label, line) => {
      const html = (openTag: string) =>
        `${openTag}\n${line}\n</script>\n<p>After</p>`;
      const javaScript = await tokenize(html("<script>"));
      const typeScript = await tokenize(
        html('<script type="text/typescript">'),
      );
      const after = (tokens: Token[]) =>
        tokens.filter((token) => token.text === "After").map(isInScript);
      expect(after(typeScript)).toEqual(after(javaScript));
      const closingTags = (tokens: Token[]) =>
        tokens
          .filter((token) => /^script$/i.test(token.text))
          .map(
            (token) =>
              `${token.line}:${token.scopes.includes("entity.name.tag.html")}`,
          );
      expect(closingTags(typeScript)).toEqual(closingTags(javaScript));
    },
  );

  // VS Code's JavaScript embedding ends a comment only at a lower-case `</script`, though it ends the block itself
  // at any case, as a browser does. The TypeScript embedding ends the comment at any case too.
  it.each([
    ["a line comment", "  // see </SCRIPT> for details"],
    ["a block comment", "  /* see </Script> */"],
  ])(
    "ends %s at an upper-case </SCRIPT>, as a browser does",
    async (_label, line) => {
      const tokens = await tokenize(
        `<script type="text/typescript">\n${line}\n<p>After</p>`,
      );
      const closing = tokens.filter((token) => /^script$/i.test(token.text))[1];
      expect(closing?.scopes).toContain("entity.name.tag.html");
      expect(isInScript(tokenFor(tokens, "p"))).toBe(false);
    },
  );

  it("ends a line comment at </script> and returns to HTML", async () => {
    const tokens = await tokenize(
      '<script type="text/typescript">// note</script><p>After</p>',
    );
    expect(tokenFor(tokens, "note").scopes).toContain(
      "comment.line.double-slash.ts",
    );
    const after = tokenFor(tokens, "p");
    expect(after.scopes).toContain("entity.name.tag.html");
    expect(isInScript(after)).toBe(false);
  });
});
