// The agent skills teach semantic HTML (Collin 2026-10-29: "Bascik is all about web standards, which also means an
// emphasis on semantic HTML. Not sure our docs or skills mention this, but it should.").
//
// - The bascik skill has a semantic HTML rule next to the component rules that routes to /component-best-practices#use-htmls-elements (skills are
//   routers: the docs page is the reference), and its audit description names the semantic rules the script checks.
// - bascik-migrate and bascik-refactor say to keep or improve semantics and never turn semantic markup into divs;
//   a refactor that fixes non-semantic production markup logs it in the decisions ledger like a production defect.
// - The AGENTS.md brief the starter writes has one semantic HTML house rule, identical in create and pkg.
//
// Misuse lens: a rule that suggests Bascik enforces or rewrites markup, a reference copy of the docs in a skill, a
// skill whose audit list drifts from the script's --help, and the two AGENTS.md templates drifting apart.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => readFileSync(repo + rel, "utf8");
const SEMANTIC_RULES = [
  "clickable-element",
  "generic-root",
  "skipped-heading",
  "missing-alt",
  "unlabeled-control",
  "missing-main",
];

describe("bascik skill: semantic HTML", () => {
  const skill = read("skills/bascik/SKILL.md");
  const docs = read("docs/content/component-best-practices.md");

  it("has a numbered Semantic HTML rule among the must-follow rules", () => {
    const rules = skill.slice(skill.indexOf("## Rules (must follow)"));
    expect(rules).toMatch(/\n\d+\. \*\*Semantic HTML\.\*\*/);
    const rule = /\n\d+\. \*\*Semantic HTML\.\*\*([^\n]*)/.exec(rules)![1];
    for (const word of ["<nav>", "<button", "<main>", "<h1>", "label", "alt"])
      expect(rule, word).toContain(word);
  });

  it("routes to the /component-best-practices docs page, which covers the checklist with spec links, and holds no reference copy", () => {
    expect(skill).toContain(
      "read-doc.mjs /component-best-practices#use-htmls-elements",
    );
    expect(skill).not.toContain("references/semantic-html.md");
    expect(existsSync(repo + "skills/bascik/references")).toBe(false);
    for (const topic of [
      "<nav",
      "<header>",
      "<footer>",
      "<main",
      "<article>",
      "<section>",
      "<button",
      "<details>",
      "<dialog>",
      "popover",
      "<fieldset>",
      "<legend>",
      "<figure>",
      "<time",
      "<address>",
      "<table>",
      "lang",
      "alt",
    ])
      expect(docs, topic).toContain(topic);
    expect(docs).toContain("https://html.spec.whatwg.org/");
    expect(docs).toContain("https://developer.mozilla.org/");
    expect(docs).not.toMatch(/Bascik (enforces|rewrites|rejects)/);
  });

  it("says an attribute already on the root wins over the usage tag's, so a nav's label goes on the usage tag", () => {
    // Real build: <nav aria-label="Root"> used as <site-nav aria-label="Usage" /> ships aria-label="Root".
    expect(docs).toMatch(/already on the root wins/);
    expect(docs).toMatch(/<site-nav aria-label="[^"]+" \/>/);
  });

  it("does not make every card an <article>: only one that stands on its own (WHATWG)", () => {
    expect(docs).not.toMatch(/\|\s*`\*-card`[^\n]*`<article>`/);
    expect(docs).toMatch(/card[^\n]*stands on its own/);
    expect(skill).not.toMatch(
      /card an `<article>`|`<review-card>` an `<article>`/,
    );
  });

  it("names every semantic audit rule the script's --help lists", () => {
    const help = spawnSync(
      process.execPath,
      [repo + "skills/bascik/scripts/audit-components.mjs", "--help"],
      { encoding: "utf8" },
    ).stdout;
    for (const rule of SEMANTIC_RULES) {
      expect(help, rule).toContain(rule);
      expect(docs, rule).toContain(rule);
    }
    expect(skill).toMatch(/audit-components\.mjs[^\n]*clickable/);
  });
});

describe("migrate and refactor skills keep semantics", () => {
  it("bascik-migrate says to keep or improve semantics and never turn semantic markup into divs", () => {
    const migrate = read("skills/bascik-migrate/SKILL.md");
    expect(migrate).toMatch(/semantic/i);
    expect(migrate).toMatch(
      /never turn semantic (markup|elements) into `?<div>`?s?/i,
    );
    expect(migrate).toContain(
      "read-doc.mjs /component-best-practices#use-htmls-elements",
    );
  });

  it("bascik-refactor carries the clean semantic HTML stance and logs fixes in the decisions ledger", () => {
    const refactor = read("skills/bascik-refactor/SKILL.md");
    expect(refactor).toMatch(/semantic/i);
    expect(refactor).toMatch(
      /never turn semantic (markup|elements) into `?<div>`?s?/i,
    );
    expect(refactor).toMatch(/decisions ledger/i);
    expect(refactor).toMatch(/production defect/i);
    expect(refactor).toContain(
      "read-doc.mjs /component-best-practices#use-htmls-elements",
    );
    expect(refactor).not.toContain("references/semantic-html.md");
  });
});

describe("AGENTS.md brief", () => {
  it("has one semantic HTML house rule, and create and pkg keep identical copies", () => {
    const create = read("create/src/agent-setup.ts");
    const pkg = read("pkg/src/lib/agent-setup.ts");
    expect(pkg).toBe(create);
    const rules = create.slice(
      create.indexOf("### House rules"),
      create.indexOf("### Agent skills"),
    );
    const semantic = rules
      .split("\n")
      .filter((line) => line.startsWith("- ") && /semantic HTML/i.test(line));
    expect(semantic).toHaveLength(1);
    expect(semantic[0]).toContain(
      "/component-best-practices#use-htmls-elements)",
    );
  });
});
