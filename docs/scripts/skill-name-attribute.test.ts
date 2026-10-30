// The agent skills teach that `name` is a page-level contract (Collin 2026-10-29): Bascik ships it as written, a
// component that holds a whole radio group needs its own <form> or a name prop, and the linter warns
// `shared-name-group`.
//
// Misuse lens: a skill that still says `name` is scoped per instance or that forms need data-bascik-preserve="name",
// a fix the skill names that the linter message does not (or the other way round), and a docs path that is not a
// page in the nav.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAV } from "../src/lib/nav.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(repo + rel, "utf8");
const navHrefs = NAV.flatMap((section) => section.pages.map((p) => p.href));

describe("bascik-components skill: the name attribute", () => {
  const skill = read("skills/bascik-components/SKILL.md");
  const rules = skill.slice(skill.indexOf("## Script rules (must follow)"));
  const rule = /\n\d+\. \*\*`name` ships as written[^\n]*/.exec(rules)?.[0];

  it("has a must-follow rule that name ships as written", () => {
    expect(rule).toBeDefined();
  });

  it("names both fixes for a repeated radio group, the lint rule, and the clobbering hazard", () => {
    for (const text of [
      "<form>",
      'data-bascik-attr-name="group"',
      "data-bascik-prop-group",
      "shared-name-group",
      "`action`",
      "`submit`",
      "/component-best-practices#name-form-controls-and-groups",
    ])
      expect(rule, text).toContain(text);
  });

  it("no longer teaches name scoping as the default", () => {
    expect(skill).not.toContain("`FormData` keys are scoped");
    expect(skill).not.toMatch(
      /name\s+->\s+bascik__<component>__<instance>__<name>\s+unique per instance/,
    );
    expect(skill).toMatch(/name\s+->\s+name\s+as written/);
  });

  it("points at a docs page that is in the nav", () => {
    expect(navHrefs).toContain("/component-best-practices");
  });
});

describe("bascik-compatibility skill: the name attribute", () => {
  const skill = read("skills/bascik-compatibility/SKILL.md");

  it("says name ships as written and how to opt in", () => {
    expect(skill).toContain("**`name` ships as written**");
    expect(skill).toContain("scoping.attributes.name: true");
    expect(skill).toContain("shared-name-group");
    expect(skill).not.toContain("`name` attributes are scoped per instance");
  });
});

describe("the fixes the skills name match the linter's message", () => {
  const message = read("lsp/src/name-groups.ts");

  it("the language server's message names the same two fixes", () => {
    expect(message).toContain("Wrap the radios in the component's own <form>");
    expect(message).toContain('data-bascik-attr-name="group"');
    expect(message).toContain('data-bascik-prop-group="..."');
  });
});
