import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
