import { readFileSync } from "node:fs";
import { join } from "node:path";
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
});
