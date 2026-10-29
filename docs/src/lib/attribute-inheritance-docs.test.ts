/**
 * The one exception to "inherited attributes are copied as written" (Collin 2026-10-29: "I agree with this, just
 * make sure its documented").
 *
 * An attribute that becomes a URL only because of the component root's real tag (`data` on an `<object>` root, the
 * values of an SVG animation root) gets the URL check, and a script URL there becomes about:invalid with a warning.
 * pkg/src/lib/component-inheritance.ts (mergeAttributesOntoRoot) implements it.
 *
 * - /attribute-inheritance has a subsection for it, with its anchor, a component-demo box (Usage, HTML, Output), the
 *   exact warning Bascik prints, why only this case is checked, and that your own onclick, style and href are copied
 *   as written, with a link to /security.
 * - security.md, server-scripts.md and compatibility.md each link to that subsection instead of restating the rule.
 * - The quoted warning is the implementation's message, with the prefix the compiler adds.
 *
 * docs/scripts/url-root-demos.test.ts builds the demo with the real compiler and compares the Output and the warning.
 *
 * Misuse lens: a page that keeps the old dense sentence (and drifts from the rule), a link to a stale anchor, a quoted
 * warning that no longer matches what Bascik prints, a demo box missing from the page shell, and a subsection that
 * suggests your own onclick or href gets checked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { slugFromHeadingHtml } from "./heading-slug.ts";

const DOCS = path.resolve(import.meta.dirname, "../..");
const REPO = path.resolve(DOCS, "..");
const read = (rel: string): string =>
  readFileSync(path.join(DOCS, rel), "utf8");
const readRepo = (rel: string): string =>
  readFileSync(path.join(REPO, rel), "utf8");

const HEADING = "Attributes That Become URLs on the Root";
const ANCHOR = `/attribute-inheritance#${slugFromHeadingHtml(HEADING)}`;

const md = read("content/attribute-inheritance.md");

/** The text under `### heading`, up to the next heading of level 2 or 3. */
const subsection = (text: string, heading: string): string => {
  const start = text.indexOf(`\n### ${heading}\n`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 6);
  const end = rest.search(/\n#{2,3} /);
  return end === -1 ? rest : rest.slice(0, end);
};

/** The `## heading` section, up to the next `## `. */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
};

/** Prose only: fenced blocks and demo markers removed, whitespace collapsed. */
const prose = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\s+/g, " ");

/** The warning Bascik prints, rebuilt from the implementation's own template literals. */
const implementationWarning = (): string => {
  const inheritance = readRepo("pkg/src/lib/component-inheritance.ts");
  const message = /`(inherited attribute \$\{name\} received a URL[^`]*)`/.exec(
    inheritance,
  )?.[1];
  expect(
    message,
    "the warning template in component-inheritance.ts",
  ).toBeDefined();
  const core = readRepo("pkg/src/lib/component-expansion-core.ts");
  const prefix =
    /warn\(`(<\$\{usage\.name\}> \(\$\{usage\.fileName \|\| "unknown file"\}\): )\$\{message\}`\)/.exec(
      core,
    )?.[1];
  expect(
    prefix,
    "the propWarn prefix in component-expansion-core.ts",
  ).toBeDefined();
  return (prefix! + message!)
    .replace("${usage.name}", "my-embed")
    .replace(
      '${usage.fileName || "unknown file"}',
      "components/my-embed/my-embed.html",
    )
    .replaceAll("${name}", "data")
    .replaceAll("${rootName}", "object")
    .replaceAll("${BLOCKED_URL}", "about:invalid");
};

describe("/attribute-inheritance: Attributes That Become URLs on the Root", () => {
  const sub = subsection(md, HEADING);

  it("is a ### subsection of What Gets Inherited, so its anchor is stable", () => {
    expect(sub, `### ${HEADING}`).not.toBe("");
    expect(section(md, "What Gets Inherited")).toContain(`### ${HEADING}`);
    expect(ANCHOR).toBe(
      "/attribute-inheritance#attributes-that-become-urls-on-the-root",
    );
  });

  it("states the rule: copied as written, except data on an <object> root and SVG animation values", () => {
    const text = prose(sub);
    expect(text).toMatch(/exactly as written/i);
    expect(text).toContain("`data` on an `<object>` root");
    expect(text).toMatch(/`to`, `from`, `by`.*`values`/);
    // Names javascript: as the example; the exact list lives on the Security page.
    expect(text).toContain("`javascript:`");
    // An <object> loads a page, so even an image data: URL is refused there.
    expect(text).toContain("`data:image/...` included");
    expect(text).toContain("`about:invalid`");
  });

  it("says why only this case is checked: neither html nor the author could see the root's tag", () => {
    const text = prose(sub);
    expect(text).toMatch(/cannot know|could not know|could not see/i);
    expect(text).toContain("`html`");
  });

  it("says your own onclick, style and href are copied as written, and links to /security for visitor data", () => {
    const text = prose(sub);
    for (const name of ["`onclick`", "`style`", "`href`"])
      expect(text, name).toContain(name);
    expect(text).toMatch(/\]\(\/security(#[\w-]+)?\)/);
    // Misuse: nothing suggests your own markup is filtered.
    expect(text).not.toMatch(/onclick[^.]*(removed|dropped|stripped)/i);
  });

  it("quotes the exact warning Bascik prints, naming the component file", () => {
    const warning = implementationWarning();
    expect(warning).toBe(
      "<my-embed> (components/my-embed/my-embed.html): inherited attribute data received a URL that can run script (a javascript:, vbscript: or data: URL), so data on the root <object> is set to about:invalid.",
    );
    const fence = /```text\n([\s\S]*?)\n```/.exec(sub)?.[1];
    expect(fence, "a ```text fence with the warning").toBe(warning);
  });

  it("has the demo blocks: Usage, the component HTML, and a generated Output", () => {
    for (const marker of [
      "url-root-usage",
      "url-root-source-html",
      "url-root-output-html",
    ])
      expect(sub, marker).toContain(`<!-- demo:${marker} -->`);
    expect(sub).toContain('<object type="text/html"');
    expect(sub).toMatch(/data="https:\/\/[^"]+"/);
    expect(sub).toContain('data="javascript:');
  });

  it("the page shell renders the subsection with its demo blocks stripped and shows a component-demo box for it", () => {
    const shell = read("src/pages/attribute-inheritance.html");
    expect(shell).toContain(`from: "${HEADING}"`);
    expect(shell).toContain(`to: "${HEADING}"`);
    expect(shell).toContain('data-bascik-prop-file="src/components/my-embed/"');
    for (const marker of [
      "url-root-usage",
      "url-root-source-html",
      "url-root-output-html",
    ])
      expect(shell, marker).toContain(`"${marker}"`);
    // The subsection's range strips its demo blocks, so they are not printed twice.
    const range = shell.slice(shell.indexOf(`from: "${HEADING}"`));
    expect(range.slice(0, 300)).toContain("stripDemoBlocks: true");
  });

  it("the old dense sentence is gone from What Gets Inherited", () => {
    const before = section(md, "What Gets Inherited").split(
      `### ${HEADING}`,
    )[0];
    expect(before).not.toContain("The one exception is");
  });
});

describe("the other pages link to the subsection instead of restating it", () => {
  it.each([
    "content/security.md",
    "content/server-scripts.md",
    "content/compatibility.md",
  ])("%s links to the anchor and no longer restates the data: rule", (file) => {
    const text = read(file);
    expect(text).toContain(`](${ANCHOR})`);
    // The restated rule drifts; one link replaces it.
    expect(text).not.toContain("`data:image/...` included");
    expect(text).not.toMatch(/URL only on the root's (own )?tag/);
  });

  it("compatibility's table row still says inherited values are kept as written, with the quote encoded", () => {
    const row = read("content/compatibility.md")
      .split("\n")
      .find((line) =>
        line.startsWith(
          "| Escaped visitor values in props, bindings, and inherited attributes",
        ),
      );
    expect(row).toBeDefined();
    expect(row).toMatch(/quote character it is written in encoded/);
    expect(row).toContain(ANCHOR);
    // Still one table row: no raw newline or unescaped pipe inside the cell.
    expect(row!.split(" | ").length).toBe(3);
  });
});
