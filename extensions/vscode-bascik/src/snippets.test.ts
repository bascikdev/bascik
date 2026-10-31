import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const extensionRoot = join(__dirname, "..");

interface Snippet {
  prefix: string;
  body: string[];
}

const manifest = JSON.parse(
  readFileSync(join(extensionRoot, "package.json"), "utf8"),
) as { contributes: { snippets: { language: string; path: string }[] } };

/** The snippets VS Code offers in a file of `language`, from every snippet file contributed for it. */
function snippetsFor(language: string): Snippet[] {
  return manifest.contributes.snippets
    .filter((contribution) => contribution.language === language)
    .flatMap((contribution) =>
      Object.values(
        JSON.parse(
          readFileSync(join(extensionRoot, contribution.path), "utf8"),
        ) as Record<string, Snippet>,
      ),
    );
}

/** The `params` type of `ApiHandlerContext`, the context Bascik passes to every API route handler. */
function declaredParamsType(): string {
  const source = readFileSync(
    join(extensionRoot, "../../pkg/src/lib/request-execution.ts"),
    "utf8",
  );
  const declaration =
    /export interface ApiHandlerContext \{[\s\S]*?\bparams: ([^;]+);/.exec(
      source,
    );
  expect(declaration, "ApiHandlerContext declares params").not.toBeNull();
  return declaration![1];
}

/** The text a snippet inserts when every placeholder keeps its default (and a choice its first option). */
function expand(body: string[]): string {
  return body
    .join("\n")
    .replace(/\$\{\d+\|([^,|]*)[^}]*\}/g, (_match, first: string) => first)
    .replace(/\$\{\d+:([^}]*)\}/g, (_match, value: string) => value)
    .replace(/\$\d+/g, () => "");
}

interface ApiRouteDiagnostic {
  code: string;
}

/**
 * The language server's API route rules, from its source. Imported by path at run time because the
 * extension's tsconfig compiles only `src/`; the extension bundles the same module.
 */
async function analyzeApiRoute(text: string): Promise<ApiRouteDiagnostic[]> {
  const rules = (await import(
    pathToFileURL(join(extensionRoot, "../../lsp/src/api-rules.ts")).href
  )) as { analyzeApiRouteSource(text: string): ApiRouteDiagnostic[] };
  return rules.analyzeApiRouteSource(text);
}

describe("API route snippets", () => {
  const prefixes = ["bascik-api", "bascik-get", "bascik-post"];

  it.each(["typescript", "javascript"])(
    "offers every route snippet in %s files",
    (language) => {
      expect(snippetsFor(language).map((snippet) => snippet.prefix)).toEqual(
        prefixes,
      );
    },
  );

  it("types params as the handler context does, so a catch-all's string[] is not hidden", () => {
    const paramsType = declaredParamsType();
    expect(paramsType).toBe("Record<string, string | string[]>");
    for (const snippet of snippetsFor("typescript")) {
      const body = snippet.body.join("\n");
      expect(body, snippet.prefix).toContain(`params: ${paramsType};`);
    }
  });

  it("inserts no TypeScript annotations into a JavaScript file", () => {
    for (const snippet of snippetsFor("javascript")) {
      const body = snippet.body.join("\n");
      expect(body, snippet.prefix).not.toMatch(
        /:\s*(?:Request|Promise<|\{\s*params)/,
      );
      expect(body, snippet.prefix).toMatch(/export const \S+ = async \(/);
    }
  });

  it.each(["typescript", "javascript"])(
    "inserts %s handlers the language server reports nothing on, so bascik-post guards its JSON parse",
    async (language) => {
      for (const snippet of snippetsFor(language)) {
        const inserted = expand(snippet.body);
        expect(await analyzeApiRoute(inserted), snippet.prefix).toEqual([]);
      }
      const post = snippetsFor(language).find(
        (snippet) => snippet.prefix === "bascik-post",
      )!;
      const inserted = expand(post.body);
      expect(inserted).toContain("await request.json()");
      expect(inserted).toMatch(/status: 400/);
    },
  );
});
