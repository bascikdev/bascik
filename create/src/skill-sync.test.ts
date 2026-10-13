import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILLS_DIR } from "./scaffold.js";

const sourceDir = resolve(import.meta.dirname, "../../skills");

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1).replace(/\\/g, "/"))
    .sort();
}

describe("agent skills asset synchronization", () => {
  it("create/assets/skills is a byte-identical copy of the repo-root skills/ directory", async () => {
    expect(resolve(SKILLS_DIR)).toBe(resolve(import.meta.dirname, "../assets/skills"));
    const [sourceFiles, bundledFiles] = await Promise.all([listFiles(sourceDir), listFiles(SKILLS_DIR)]);
    expect(sourceFiles).toContain("bascik/SKILL.md");
    expect(bundledFiles, "run `yarn create:prepack` to refresh create/assets/skills").toEqual(sourceFiles);
    for (const file of sourceFiles) {
      const [source, bundled] = await Promise.all([
        readFile(join(sourceDir, file)),
        readFile(join(SKILLS_DIR, file)),
      ]);
      expect(bundled.equals(source), `${file} differs; run \`yarn create:prepack\``).toBe(true);
    }
  });
});
