/**
 * Portable template instantiation (prompt 157).
 *
 * `scoping-instantiate.ts` holds the half of `scoping-template.ts` that a
 * request-time renderer needs: `join` and `instantiateTemplate`, which replay
 * a recorded `ScopingTemplate` for a fresh instance id through a host-supplied
 * name hash. It must reproduce `runScopingPipeline` byte-for-byte for
 * request-shaped ids (`r` + 7 hex) in both identifier modes, after a JSON
 * round trip (the manifest is JSON), and `scoping-template.ts` must get the
 * same answer by delegating to it with `minifyAttributeName`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: true },
    scoping: {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      preserve: ["code"],
      deduplicateCss: true,
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
    isBuild: true,
  },
  shouldLog: vi.fn(() => true),
}));

import { BascikConfig } from "./config.ts";
import {
  applyScopingResult,
  instantiateTemplate,
  join,
  replayTemplateTokens,
} from "./scoping-instantiate.ts";
import {
  buildScopingTemplate,
  instantiateScopingTemplate,
  recordScopingRun,
  runScopingPipeline,
  type ScopingTemplate,
  __scopingTemplateInternalsForTests as internals,
} from "./scoping-template.ts";
import { getAttributeNameHash } from "./names.ts";
import type { BascikComponent } from "./types.ts";

const card = (): BascikComponent => ({
  name: "my-card",
  fileName: "/project/src/components/my-card/my-card.html",
  fileContent: `<div id="root" class="card"><label for="field">L</label><input id="field" name="q">
<button class="toggle" aria-controls="root">t</button></div>
<script>const root = document.getElementById("root"); root.querySelector(".toggle").classList.add("on");</script>`,
  cssFileContent:
    "#root { margin: 0 } .card { padding: 0 } .toggle { color: red }",
});

const glowCard = (): BascikComponent => ({
  name: "glow-card",
  fileName: "/project/src/components/glow-card/glow-card.html",
  fileContent: `<svg><filter id="glow"></filter></svg><div class="box"><style>.box { filter: url(#glow) }</style></div>`,
  cssFileContent: ".box { clip-path: url(#glow) }",
});

/** The id the template is recorded with at build time; never a request id. */
const SEED_ID = "deadbeef";
const REQUEST_IDS = ["r1a2b3c4", "r0badf00"];

/** Record, build, and round-trip through JSON as the manifest does. */
const templateFor = (component: BascikComponent): ScopingTemplate => {
  const recorded = recordScopingRun({ ...component }, SEED_ID);
  expect(recorded.clean).toBe(true);
  const template = buildScopingTemplate(
    internals.inputTexts(component),
    SEED_ID,
    recorded.calls,
    internals.snapshotResult(recorded.component),
  );
  expect(template).not.toBeNull();
  return JSON.parse(JSON.stringify(template)) as ScopingTemplate;
};

const realFor = (component: BascikComponent, instanceId: string) =>
  internals.snapshotResult(runScopingPipeline({ ...component }, instanceId));

const identity = (input: string): string => input;

describe("join", () => {
  it("interleaves parts with the token values in recorded order", () => {
    expect(join({ parts: ["a", "b", "c"], tokens: [1, 0] }, ["X", "Y"])).toBe(
      "aYbXc",
    );
    expect(join({ parts: ["only"], tokens: [] }, ["unused"])).toBe("only");
    expect(join({ parts: ["", ""], tokens: [0] }, ["X"])).toBe("X");
  });
});

describe.each([true, false])(
  "instantiateTemplate (identifiers %s)",
  (identifiers) => {
    const hashName = identifiers ? getAttributeNameHash : identity;

    beforeEach(() => {
      (BascikConfig.minify as { identifiers: boolean }).identifiers =
        identifiers;
    });

    for (const id of REQUEST_IDS) {
      it(`reproduces runScopingPipeline for ${id} on a component with ids, names, classes and a script`, () => {
        const template = templateFor(card());
        const real = realFor(card(), id);
        const predicted = instantiateTemplate(template, id, hashName);
        expect(predicted).toEqual(real);
        // The request id really reached the output.
        expect(predicted?.fileContent).toContain(
          identifiers
            ? hashName(`bascik__my-card__${id}__root`)
            : `bascik__my-card__${id}__root`,
        );
        expect(predicted?.scopedIdNames).toBe(real.scopedIdNames);
      });

      it(`reproduces per-instance CSS and scoped id names for ${id}`, () => {
        const template = templateFor(glowCard());
        const real = realFor(glowCard(), id);
        expect(real.requiresPerInstanceCss).toBe(true);
        const predicted = instantiateTemplate(template, id, hashName);
        expect(predicted).toEqual(real);
        expect(predicted?.cssFileContent).toBe(real.cssFileContent);
        expect(JSON.parse(predicted!.scopedIdNames!)).toEqual(
          JSON.parse(real.scopedIdNames!),
        );
      });

      it(`agrees with instantiateScopingTemplate for ${id} (scoping-template.ts delegates)`, () => {
        for (const component of [card(), glowCard()]) {
          const template = templateFor(component);
          expect(instantiateTemplate(template, id, hashName)).toEqual(
            instantiateScopingTemplate(
              template,
              id,
              internals.inputTexts(component),
            ),
          );
        }
      });
    }

    it("replays every hash step through the supplied hashName and nothing else", () => {
      const template = templateFor(card());
      const seen: string[] = [];
      const spyHash = (input: string): string => {
        seen.push(input);
        return hashName(input);
      };
      instantiateTemplate(template, REQUEST_IDS[0], spyHash);
      expect(seen).toHaveLength(template.steps.length);
      // Every replayed input names the request id or a token derived from it.
      for (const input of seen) expect(input).not.toContain(SEED_ID);
      if (template.steps.length > 0) expect(seen[0]).toContain(REQUEST_IDS[0]);
    });

    it("does not run the authored-text collision check (excluded by construction at request time)", () => {
      // scoping-template.ts refuses to instantiate when a computed name occurs
      // in the authored text; the manifest never ships that text, so the
      // portable function has no `inputs` and returns the replayed result.
      const id = REQUEST_IDS[1];
      const collidingName = hashName(`bascik__my-card__${id}__root`);
      const component = {
        ...card(),
        fileContent: `${card().fileContent}<!-- ${collidingName} -->`,
      };
      const template = templateFor(component);
      expect(
        instantiateScopingTemplate(
          template,
          id,
          internals.inputTexts(component),
        ),
      ).toBeNull();
      const predicted = instantiateTemplate(template, id, hashName);
      expect(predicted).not.toBeNull();
      expect(predicted?.fileContent).toContain(`<!-- ${collidingName} -->`);
      expect(predicted?.fileContent).toContain(`id="${collidingName}"`);
    });
  },
);

describe("replayTemplateTokens", () => {
  // Only identifier minification records hash steps; with the identity hash
  // the sole token is the id, so this is the only mode with names to collide.
  beforeEach(() => {
    (BascikConfig.minify as { identifiers: boolean }).identifiers = true;
  });

  it("returns null when two replayed names coincide, which the template cannot represent", () => {
    // Every token must map to a distinct name: the template was segmented on
    // distinct tokens, so two equal values would merge two names that the
    // real pipeline keeps apart. The id itself is token 0, so a hash that
    // returns the id collides as well.
    const template = templateFor(card());
    expect(template.steps.length).toBeGreaterThan(1);
    const constant = (): string => "same";
    expect(replayTemplateTokens(template, REQUEST_IDS[0], constant)).toBeNull();
    expect(instantiateTemplate(template, REQUEST_IDS[0], constant)).toBeNull();
    const echoId = (): string => REQUEST_IDS[0];
    expect(instantiateTemplate(template, REQUEST_IDS[0], echoId)).toBeNull();
    // Distinct names replay fine with the same template.
    expect(
      instantiateTemplate(template, REQUEST_IDS[0], getAttributeNameHash),
    ).not.toBeNull();
  });
});

describe("applyScopingResult", () => {
  it("copies a ScopingResult onto a component, parsing scopedIdNames and deleting absent fields", () => {
    const component: BascikComponent = {
      ...card(),
      scopedIdNames: { stale: "x" },
      requiresPerInstanceCss: true,
    };
    const applied = applyScopingResult(component, {
      fileContent: "<div>out</div>",
      cssFileContent: undefined,
      scopedIdNames: JSON.stringify({ root: "r1" }),
      requiresPerInstanceCss: undefined,
    });
    expect(applied).toBe(component);
    expect(applied.fileContent).toBe("<div>out</div>");
    expect(applied.scopedIdNames).toEqual({ root: "r1" });
    expect("cssFileContent" in applied).toBe(false);
    expect("requiresPerInstanceCss" in applied).toBe(false);

    const kept = applyScopingResult(card(), {
      fileContent: "<p>k</p>",
      cssFileContent: ".a{b:c}",
      scopedIdNames: undefined,
      requiresPerInstanceCss: false,
    });
    expect(kept.cssFileContent).toBe(".a{b:c}");
    expect("scopedIdNames" in kept).toBe(false);
    expect(kept.requiresPerInstanceCss).toBe(false);
  });

  it("matches what scoping-template.ts applies for a reused template", () => {
    (BascikConfig.minify as { identifiers: boolean }).identifiers = true;
    const template = templateFor(glowCard());
    const predicted = instantiateTemplate(
      template,
      REQUEST_IDS[0],
      getAttributeNameHash,
    );
    expect(predicted).not.toBeNull();
    const applied = applyScopingResult(glowCard(), predicted!);
    const real = runScopingPipeline(glowCard(), REQUEST_IDS[0]);
    expect(applied).toEqual(real);
  });
});
