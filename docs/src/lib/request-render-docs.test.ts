/**
 * The docs for request-time render failures say what the code does.
 *
 * 1. A render failure (an instance, size, depth or nested-job budget, or a
 *    "failed during <stage>" failure) follows `scripts.onServerScriptError`
 *    like any other script failure: no page may still say the policy does
 *    not apply, or that a budget is a 500 even under 'warn' or 'ignore'.
 * 2. The troubleshooting entry for "failed during <stage>" quotes the
 *    message the renderer prints (pkg/src/lib/request-render.ts), names
 *    every stage the expansion loop reports (component-expansion-core.ts),
 *    and, when it sends the reader to `bascik --build` to reproduce the
 *    failure, quotes the message the build prints for one
 *    (component-expansion.ts), so a reader can find it in the build log.
 *
 * Misuse lens: stale wording left behind in one of the places that describe
 * the behavior (docs pages, the bundled skill and its copy in create), and an
 * entry whose quoted message drifted from the source.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DOCS_ROOT = path.resolve(import.meta.dirname, "../..");
const REPO_ROOT = path.resolve(DOCS_ROOT, "..");
const read = (rel: string) => readFile(path.join(REPO_ROOT, rel), "utf8");

/** Every place that describes what a render failure does to a response. */
const POLICY_PAGES = [
  "docs/content/server-scripts.md",
  "docs/content/compatibility.md",
  "docs/content/testing/troubleshooting.md",
  "docs/content/internals/server.md",
  "skills/bascik-scripts/SKILL.md",
];

/** The section of `markdown` under the heading that contains `marker`. */
const sectionContaining = (markdown: string, marker: string): string => {
  const lines = markdown.split("\n");
  const start = lines.findIndex(
    (line) => /^#{2,4}\s/.test(line) && line.includes(marker),
  );
  expect(start, `a heading containing ${marker}`).toBeGreaterThanOrEqual(0);
  const level = /^(#+)/.exec(lines[start])![1].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const heading = /^(#+)\s/.exec(lines[i]);
    if (heading && heading[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
};

describe("request-time render failures follow scripts.onServerScriptError (docs)", () => {
  it.each(POLICY_PAGES)(
    "misuse: %s does not say the policy is bypassed for render failures",
    async (rel) => {
      const text = (await read(rel)).replace(/\s+/g, " ");
      const stale =
        /.{0,120}(?:does not apply to these render failures|policy does not reach a `?RequestRenderError|a 500 even under `?onServerScriptError).{0,60}/.exec(
          text,
        );
      expect(stale?.[0]).toBeUndefined();
    },
  );
});

describe("each place tells 'warn' from 'ignore' for a render failure", () => {
  it.each(POLICY_PAGES)(
    "misuse: %s says 'warn' logs the failure",
    async (rel) => {
      const text = (await read(rel)).replace(/\s+/g, " ");
      // The policy sentence for render failures, wherever the page puts it.
      const sentence =
        /[^.]*(?:Over a budget|over budget|Over budget|RequestRenderError|render failure)[^]*?`'ignore'`[^.]*\./.exec(
          text,
        )?.[0];
      expect(
        sentence,
        "a sentence on render failures and the policy",
      ).toBeDefined();
      expect(sentence).toMatch(/`'warn'`(?: it)? logs/);
    },
  );
});

describe('troubleshooting: "failed during <stage>"', () => {
  it("quotes the renderer's message, names every stage, and quotes the build's message for the reproduction it suggests", async () => {
    const troubleshooting = await read(
      "docs/content/testing/troubleshooting.md",
    );
    const entry = sectionContaining(troubleshooting, "failed during");
    const heading = entry.split("\n")[0];

    // The renderer's message, with its interpolations as wildcards.
    const renderer = await read("pkg/src/lib/request-render.ts");
    expect(renderer).toContain(
      'from ${mode}-script output at "${httpPath}" failed during ${stage}: ',
    );
    expect(heading).toMatch(
      /`Rendering <[a-z][\w-]*> \([^)]*\) from (?:server|stream)-script output at "[^"]+" failed during (?:prop injection|slot resolution|attribute scoping|attribute inheritance|substitution): [^`]*`/,
    );

    // Every stage the loop can name, as the code spells it.
    const core = await read("pkg/src/lib/component-expansion-core.ts");
    const union = /export type ExpansionStage =([^;]+);/.exec(core)![1];
    // "" (prop extraction and id minting) has no name to document.
    const stages = [...union.matchAll(/"([^"]*)"/g)]
      .map((m) => m[1])
      .filter(Boolean);
    expect(stages.length).toBeGreaterThan(3);
    for (const stage of stages) expect(entry, stage).toContain(`\`${stage}\``);

    // Sending the reader to `bascik --build` is only useful if the entry
    // says what the build prints for the same failure.
    if (entry.includes("bascik --build")) {
      const expansion = await read("pkg/src/lib/component-expansion.ts");
      expect(expansion).toContain(
        "[bascik] Transpilation failed for component <${component.name}> during ${currentStage}",
      );
      expect(entry).toMatch(
        /Transpilation failed for component <[a-z][\w-]*> during (?:prop injection|slot resolution|attribute scoping|attribute inheritance|substitution)/,
      );
    }
  });
});
