import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelEvent } from "@bascik/ai";
import { booksApp } from "./books-app.ts";

const LIB = dirname(fileURLToPath(import.meta.url));

/** books-app.ts and every file it imports, directly or not, in this folder. */
function importedFiles(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (file: string): void => {
    if (found.has(file)) return;
    const source = readFileSync(join(LIB, file), "utf8");
    found.set(file, source);
    for (const [, specifier] of source.matchAll(
      /(?:import|export)\b[^"']*?from\s*["']([^"']+)["']/g,
    )) {
      if (specifier!.startsWith("./") || specifier!.startsWith("../")) {
        const target = normalize(join(dirname(file), specifier!));
        if (!target.startsWith("..")) visit(target);
      }
    }
  };
  visit(entry);
  return found;
}

describe("booksApp", () => {
  it("builds the bookshop with its tools and an offline model that answers", async () => {
    const app = booksApp({ delayMs: 0 });
    expect(app.id).toBe("books");
    expect(app.path).toBe("/");
    expect(app.tools.map((tool) => tool.name)).toEqual([
      "list_books",
      "local_time",
      "place_hold",
    ]);

    const events: ModelEvent[] = [];
    for await (const event of app.offline({
      system: "",
      messages: [{ role: "user", content: "Recommend a book" }],
    })) {
      events.push(event);
    }
    const text = events.filter((event) => typeof event === "string").join("");
    expect(text).toContain("<book-card");
    expect(text).toContain("Shipping Small Changes");
  });

  it("imports no node: module and reads no environment, so a Worker can load it", () => {
    const files = importedFiles("books-app.ts");
    expect([...files.keys()].sort()).toEqual([
      "book-tools.ts",
      "books-app.ts",
      "books.ts",
      "demo-model.ts",
    ]);
    for (const [file, source] of files) {
      expect(source, `${file} imports a node: module`).not.toContain(
        'from "node:',
      );
      expect(source, `${file} reads process.env`).not.toMatch(/process\.env/);
    }
  });
});
