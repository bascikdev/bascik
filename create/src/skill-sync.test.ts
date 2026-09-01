import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("SKILL.md asset synchronization", () => {
  it("docs and create SKILL.md copies are byte-identical", async () => {
    const docsSkillPath = resolve(import.meta.dirname, "../../docs/src/pages/assets/SKILL.md");
    const createSkillPath = resolve(import.meta.dirname, "../assets/SKILL.md");

    const [docsSkill, createSkill] = await Promise.all([
      readFile(docsSkillPath),
      readFile(createSkillPath),
    ]);

    expect(docsSkill.equals(createSkill)).toBe(true);
  });
});
