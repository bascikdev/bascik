import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  SCOPING_CONFIG_KEYS,
  SCOPING_INPUT_FIELDS,
  SCOPING_RESULT_FIELDS,
  clearScopingTemplates,
  runScopingPipeline,
  scopeComponentInstance,
  __scopingTemplateInternalsForTests as internals,
  __scopingTemplateStatsForTests as stats,
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

const ids = [
  "1a2b3c4d",
  "5e6f7a8b",
  "9c0d1e2f",
  "3a4b5c6d",
  "7e8f9a0b",
  "c1d2e3f4",
];

const realFor = (component: BascikComponent, instanceId: string) =>
  internals.snapshotResult(runScopingPipeline({ ...component }, instanceId));

const scopedFor = (component: BascikComponent, instanceId: string) =>
  internals.snapshotResult(
    scopeComponentInstance({ ...component }, instanceId),
  );

beforeEach(() => {
  clearScopingTemplates();
  stats.reset();
  (BascikConfig.minify as { identifiers: boolean }).identifiers = true;
  delete process.env.BASCIK_VERIFY_SCOPING_TEMPLATES;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scopeComponentInstance", () => {
  for (const identifiers of [true, false]) {
    it(`records, verifies twice, then reuses, always matching the real pipeline (identifiers ${identifiers})`, () => {
      (BascikConfig.minify as { identifiers: boolean }).identifiers =
        identifiers;
      for (const id of ids)
        expect(scopedFor(card(), id)).toEqual(realFor(card(), id));
      expect(stats.recorded).toBe(1);
      expect(stats.verified).toBe(2);
      expect(stats.reused).toBe(ids.length - 3);
      expect(stats.rejected).toBe(0);
    });
  }

  it("does not count the recorded instance ID again as a verification", () => {
    scopedFor(card(), ids[0]);
    scopedFor(card(), ids[0]);
    scopedFor(card(), ids[1]);
    expect(stats.verified).toBe(1);
    scopedFor(card(), ids[1]);
    expect(stats.verified).toBe(1);
    expect(stats.reused).toBe(0);
  });

  it("keeps a separate template per distinct input", () => {
    const other = {
      ...card(),
      fileContent: card().fileContent.replace("card", "panel"),
    };
    for (const id of ids) {
      expect(scopedFor(card(), id)).toEqual(realFor(card(), id));
      expect(scopedFor(other, id)).toEqual(realFor(other, id));
    }
    expect(internals.entryCount()).toBe(2);
  });

  it("applies per-instance CSS, scoped id names, and the per-instance flag", () => {
    const component: BascikComponent = {
      name: "glow-card",
      fileName: "/project/src/components/glow-card/glow-card.html",
      fileContent: `<svg><filter id="glow"></filter></svg><div class="box"><style>.box { filter: url(#glow) }</style></div>`,
      cssFileContent: ".box { clip-path: url(#glow) }",
    };
    for (const id of ids) {
      const scoped = scopeComponentInstance({ ...component }, id);
      const real = runScopingPipeline({ ...component }, id);
      expect(scoped.requiresPerInstanceCss).toBe(true);
      expect(scoped.scopedIdNames).toEqual(real.scopedIdNames);
      expect(internals.snapshotResult(scoped)).toEqual(
        internals.snapshotResult(real),
      );
    }
    expect(stats.reused).toBe(ids.length - 3);
  });

  it("never reuses a run that wrote to the console", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const component = {
      ...card(),
      fileContent: `<p data-bascik-preserve="bogus" class="card">x</p>`,
    };
    for (const id of ids)
      expect(scopedFor(component, id)).toEqual(realFor(component, id));
    expect(stats.rejected).toBe(1);
    expect(stats.reused).toBe(0);
    // Every instance still warns, exactly as without templates.
    expect(console.warn).toHaveBeenCalledTimes(ids.length * 2);
  });

  it("never reuses a run that planned a CSS @import", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const component = {
      ...card(),
      cssFileContent: `@import "./missing.css";\n.card { color: red }`,
    };
    for (const id of ids) scopedFor(component, id);
    expect(stats.reused).toBe(0);
    expect(stats.rejected).toBe(1);
  });

  it("never reuses when the instance ID occurs in the authored input", () => {
    const component = {
      ...card(),
      fileContent: `${card().fileContent}<!-- ${ids[0]} -->`,
    };
    for (const id of ids)
      expect(scopedFor(component, id)).toEqual(realFor(component, id));
    expect(stats.rejected).toBe(1);
    expect(stats.reused).toBe(0);
  });

  it("uses the real pipeline for an instance whose generated name occurs in the authored input", () => {
    const later = ids[5];
    const collidingName = getAttributeNameHash(
      `bascik__my-card__${later}__root`,
    );
    const component = {
      ...card(),
      fileContent: `${card().fileContent}<!-- ${collidingName} -->`,
    };
    for (const id of ids)
      expect(scopedFor(component, id)).toEqual(realFor(component, id));
    // ids[3] and ids[4] reuse; ids[5] collides and runs the real pipeline.
    expect(stats.reused).toBe(2);
  });

  it("disables reuse when a verification run disagrees with the prediction", () => {
    scopedFor(card(), ids[0]);
    const template = internals.templateFor(card())!;
    template.fileContent.parts[0] = `<!-- wrong -->${template.fileContent.parts[0]}`;
    for (const id of ids.slice(1))
      expect(scopedFor(card(), id)).toEqual(realFor(card(), id));
    expect(stats.rejected).toBe(1);
    expect(stats.reused).toBe(0);
    expect(internals.templateFor(card())).toBeNull();
  });

  it("throws in verify mode when a reused result differs from the real pipeline", () => {
    for (const id of ids.slice(0, 3)) scopedFor(card(), id);
    const template = internals.templateFor(card())!;
    template.fileContent.parts[0] = `<!-- wrong -->${template.fileContent.parts[0]}`;
    process.env.BASCIK_VERIFY_SCOPING_TEMPLATES = "1";
    expect(() => scopedFor(card(), ids[3])).toThrow(
      /scoping template mismatch for <my-card>.*fileContent/,
    );
  });

  it("passes verify mode for correct reuse", () => {
    process.env.BASCIK_VERIFY_SCOPING_TEMPLATES = "1";
    for (const id of ids)
      expect(scopedFor(card(), id)).toEqual(realFor(card(), id));
    expect(stats.reused).toBe(ids.length - 3);
  });

  it("bounds the number of cached templates", () => {
    for (let n = 0; n < 600; n++)
      scopedFor(
        { ...card(), fileContent: `<p class="c${n}">${n}</p>` },
        ids[0],
      );
    expect(internals.entryCount()).toBeLessThanOrEqual(512);
  });

  it("keys on config, so changing it never reuses an old template", () => {
    for (const id of ids.slice(0, 4)) scopedFor(card(), id);
    (BascikConfig.minify as { identifiers: boolean }).identifiers = false;
    expect(scopedFor(card(), ids[4])).toEqual(realFor(card(), ids[4]));
    expect(internals.entryCount()).toBe(2);
  });
});

// The cache key must include every input the pipeline reads, and the stored
// result every field it writes. Recording proxies over real components pin
// SCOPING_INPUT_FIELDS, SCOPING_RESULT_FIELDS, and SCOPING_CONFIG_KEYS.
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const corpusInputs = (): BascikComponent[] => {
  const files: string[] = [];
  for (const dir of ["docs/src/components", "pkg/e2e/src/components"]) {
    const root = join(repositoryRoot, dir);
    if (!existsSync(root)) continue;
    for (const path of readdirSync(root, { recursive: true }).map(String)) {
      if (path.endsWith(".html")) files.push(join(root, path));
    }
  }
  return files.map((htmlPath) => {
    const cssPath = htmlPath.replace(/\.html$/, ".css");
    const name = htmlPath
      .replace(/\\/g, "/")
      .split("/")
      .pop()!
      .replace(/\.html$/, "");
    return {
      name,
      fileName: htmlPath,
      fileContent: readFileSync(htmlPath, "utf8"),
      ...(existsSync(cssPath)
        ? { cssFileContent: readFileSync(cssPath, "utf8") }
        : {}),
    };
  });
};

describe("scoping pipeline inputs and outputs", () => {
  it("reads and writes only the pinned component fields", () => {
    const reads = new Set<string>();
    const writes = new Set<string>();
    let enumerated = false;
    const inputs = [...corpusInputs(), card()];
    expect(inputs.length).toBeGreaterThan(50);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const identifiers of [true, false]) {
      (BascikConfig.minify as { identifiers: boolean }).identifiers =
        identifiers;
      for (const input of inputs) {
        const target = { ...input };
        const tracked = new Proxy(target, {
          get(object, key, receiver) {
            if (typeof key === "string") reads.add(key);
            return Reflect.get(object, key, receiver);
          },
          set(object, key, value, receiver) {
            if (typeof key === "string") writes.add(key);
            return Reflect.set(object, key, value, receiver);
          },
          deleteProperty(object, key) {
            if (typeof key === "string") writes.add(key);
            return Reflect.deleteProperty(object, key);
          },
          ownKeys(object) {
            enumerated = true;
            return Reflect.ownKeys(object);
          },
        });
        runScopingPipeline(tracked as BascikComponent, "1a2b3c4d");
      }
    }
    expect(enumerated).toBe(false);
    expect(
      [...reads].filter(
        (key) => !(SCOPING_INPUT_FIELDS as readonly string[]).includes(key),
      ),
    ).toEqual([]);
    expect(
      [...writes].filter(
        (key) => !(SCOPING_RESULT_FIELDS as readonly string[]).includes(key),
      ),
    ).toEqual([]);
  });

  it("reads only the pinned config keys, and only identifiers from minify", () => {
    const config = BascikConfig as unknown as Record<string, unknown>;
    const topLevel = new Set<string>();
    const minifyReads = new Set<string>();
    const originals = new Map(
      Object.keys(config).map((key) => [key, config[key]]),
    );
    for (const [key, value] of originals) {
      Object.defineProperty(config, key, {
        configurable: true,
        enumerable: true,
        get: () => {
          topLevel.add(key);
          if (key === "minify") {
            return new Proxy(value as object, {
              get(object, nested, receiver) {
                if (typeof nested === "string") minifyReads.add(nested);
                return Reflect.get(object, nested, receiver);
              },
            });
          }
          return value;
        },
      });
    }
    try {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      for (const input of [...corpusInputs(), card()])
        runScopingPipeline({ ...input }, "1a2b3c4d");
    } finally {
      for (const [key, value] of originals) {
        Object.defineProperty(config, key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      }
    }
    expect(
      [...topLevel].filter(
        (key) => !(SCOPING_CONFIG_KEYS as readonly string[]).includes(key),
      ),
    ).toEqual([]);
    expect([...minifyReads]).toEqual(["identifiers"]);
  });

  it("keys on every pinned input field", () => {
    const base = card();
    const key = internals.inputKey(base);
    const variants: Array<Partial<BascikComponent>> = [
      { name: "other-card" },
      { fileName: "/project/src/components/other/other.html" },
      { fileContent: `${base.fileContent} ` },
      { cssFileContent: `${base.cssFileContent} ` },
      { scopedIdNames: { root: "x" } },
      { requiresPerInstanceCss: true },
    ];
    expect(variants.map((variant) => Object.keys(variant)[0]).sort()).toEqual(
      [...SCOPING_INPUT_FIELDS].sort(),
    );
    for (const variant of variants)
      expect(internals.inputKey({ ...base, ...variant })).not.toBe(key);
  });

  it("produces collision-free keys for delimiters, length aliases, null/undefined, and config mutations", () => {
    const base = card();
    expect(internals.inputKey({ ...base })).toBe(
      internals.inputKey({ ...base }),
    );

    const pairs: Array<[BascikComponent, BascikComponent]> = [
      // Boundary shifts with ':', '|', quotes, and digit length lookalikes
      [
        { ...base, name: "a:b|c", fileContent: '5:hello"world' },
        { ...base, name: "a", fileContent: 'b|c|5:hello"world' },
      ],
      [
        { ...base, name: "a|s5:hello", fileName: "x" },
        { ...base, name: "a", fileName: "hello|s1:x" },
      ],
      [
        { ...base, fileContent: "10:abcdefghij", cssFileContent: "kl" },
        { ...base, fileContent: "abcdefghij", cssFileContent: "2:kl" },
      ],
      // undefined vs string "null" or "undefined" or empty string
      [
        { ...base, fileName: undefined },
        { ...base, fileName: "null" },
      ],
      [
        { ...base, fileName: undefined },
        { ...base, fileName: "undefined" },
      ],
      [
        { ...base, fileName: undefined },
        { ...base, fileName: "" },
      ],
      [
        { ...base, cssFileContent: undefined },
        { ...base, cssFileContent: "null" },
      ],
      [
        { ...base, cssFileContent: undefined },
        { ...base, cssFileContent: "" },
      ],
      // scopedIdNames undefined vs empty object vs populated object
      [
        { ...base, scopedIdNames: undefined },
        { ...base, scopedIdNames: {} },
      ],
      [
        { ...base, scopedIdNames: { a: "b:c|d" } },
        { ...base, scopedIdNames: { "a:b": "c|d" } },
      ],
      [
        { ...base, scopedIdNames: { a: '1:"2"' } },
        { ...base, scopedIdNames: { a: "1:2" } },
      ],
      // requiresPerInstanceCss undefined vs false vs true
      [
        { ...base, requiresPerInstanceCss: undefined },
        { ...base, requiresPerInstanceCss: true },
      ],
      [
        { ...base, requiresPerInstanceCss: false },
        { ...base, requiresPerInstanceCss: true },
      ],
    ];

    for (const [left, right] of pairs) {
      expect(internals.inputKey(left)).not.toBe(internals.inputKey(right));
    }

    // In-place mutation of BascikConfig.scoping properties (preserve array, booleans, attributes)
    const scoping = BascikConfig.scoping!;
    const keyBefore = internals.inputKey(base);
    scoping.deduplicateCss = false;
    const keyAfterBool = internals.inputKey(base);
    expect(keyAfterBool).not.toBe(keyBefore);
    scoping.deduplicateCss = true;
    expect(internals.inputKey(base)).toBe(keyBefore);

    scoping.attributes.id = false;
    expect(internals.inputKey(base)).not.toBe(keyBefore);
    scoping.attributes.id = true;

    scoping.preserve.push("pre");
    expect(internals.inputKey(base)).not.toBe(keyBefore);
    scoping.preserve.pop();
    expect(internals.inputKey(base)).toBe(keyBefore);

    // Distinct preserve array elements vs single joined string with delimiters
    scoping.preserve = ["a|b", "c"];
    const keySplit1 = internals.inputKey(base);
    scoping.preserve = ["a", "b|c"];
    const keySplit2 = internals.inputKey(base);
    expect(keySplit1).not.toBe(keySplit2);
    scoping.preserve = ["code"];
  });
});
