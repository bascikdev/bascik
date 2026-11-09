import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The scoping-compatibility table on /tools/vscode-extension lists every lint rule with its severity.
 * docs/content/compatibility.md holds the rule metadata (its bascik-compatibility-rules block, the source of
 * both rules JSON files), so the table must list exactly those ids at exactly those severities.
 */
const docsDir = process.cwd();
const metadata = readFileSync(
  join(docsDir, "content/compatibility.md"),
  "utf8",
).match(/<!--\s*bascik-compatibility-rules\s*(\[[\s\S]*?\])\s*-->/);
const rules: { id: string; severity: string }[] = JSON.parse(metadata![1]);

const page = readFileSync(
  join(docsDir, "content/tools/vscode-extension.md"),
  "utf8",
);
const tableRows = [
  ...page.matchAll(/^\|[^|\n]*\|[^|\n]*\| `([a-z-]+)`\s*\| (\w+)\s*\|$/gm),
].map((m) => ({ id: m[1], severity: m[2] }));

describe("VS Code page compatibility table", () => {
  it("lists every compatibility rule with its severity", () => {
    const byId = (a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id);
    expect([...tableRows].sort(byId)).toEqual(
      rules.map(({ id, severity }) => ({ id, severity })).sort(byId),
    );
  });

  it("does not say the extension only warns", () => {
    expect(page).not.toMatch(/the extension warns about them/);
  });
});
