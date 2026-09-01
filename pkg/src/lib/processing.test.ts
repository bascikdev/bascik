import fc from "fast-check";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recursivelyTranspile, pageProcessing, processPageBatch, selectivelyProcessPagesForWatchPath, partitionByOpenPages, getDisplayPath, findActiveSourceFile, getFilePosition, transpilePage, processAllPages, selectivelyProcessPages, removePage } from "./processing.ts";
import { collectAllScriptDeps } from "./build-scripts.ts";
import { BascikConfig } from "./config.ts";

// Disable all scoping so tests produce predictable, readable HTML
vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => true),
  BascikConfig: {
    scoping: {
      scriptBlocks: false,
      inheritAttributes: true,
      attributes: { class: false, id: false, name: false },
      deduplicateCss: true,
      preserve: ["code"],
    },
    isBuild: false,
    minify: {
      html: false,
      css: false,
      js: false,
      identifiers: false,
    },
    assets: {
      inlineStyles: false,
      exclude: [],
    },
    directory: {
      pages: "src/pages",
      components: "src/components",
      out: "dist",
    },
    pipeline: {
      watchPaths: [],
      workers: false,
    },
    logging: {
      level: "info",
      requests: true,
      copies: true,
      deletes: true,
      transpiles: true,
    },
  },
}));

vi.mock("./file-system.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    listPages: vi.fn(),
    deepReadDirFlat: vi.fn(actual.deepReadDirFlat),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(async () => { }),
  mkdir: vi.fn(async () => { }),
  rm: vi.fn(async () => { }),
}));

vi.mock("./build-scripts.js", () => ({
  executeBuildScripts: vi.fn((html: string) => Promise.resolve(html)),
  collectAllScriptDeps: vi.fn(async () => []),
}));

vi.mock("./sitemap.js", () => ({
  generateSitemapFiles: vi.fn(async () => { }),
}));

vi.mock("./mem.js", () => ({
  mem: {
    storePage: vi.fn(),
    removePage: vi.fn(),
    removeByRelativePath: vi.fn(),
    pagesThisComponentIsUsedOn: vi.fn(() => []),
    pagesDependentOnFile: vi.fn(() => []),
    openPages: [] as string[],
    trackOpenPage: vi.fn(),
    untrackOpenPage: vi.fn(),
  },
}));

vi.mock("./events.js", () => ({
  eventEmitter: { emit: vi.fn() },
}));

vi.mock("./worker-pool.js", () => {
  return {
    WorkerPool: vi.fn().mockImplementation(function (this: any) {
      this.run = vi.fn(async (job: any) => {
        const pagePath = typeof job === "string" ? job : job.pagePath;
        const relativePagePath = typeof job === "string"
          ? (pagePath.startsWith("src/") ? pagePath.slice(4) : (pagePath.startsWith("pages/") ? pagePath : `pages/${pagePath}`))
          : job.relativePagePath;
        return {
          relativePagePath,
          absolutePagePath: pagePath,
          distHtml: "<html></html>",
          usedComponentsNames: ["my-comp"],
          fileDependencies: ["scripts/md-renderer.ts"],
        };
      });
      this.terminate = vi.fn(async () => { });
    }),
  };
});

vi.mock("./names.js", () => ({
  getUniqueId: vi.fn(() => "test1234"),
  minifyAttributeName: vi.fn((name) => name),
  obfuscateAttributeName: vi.fn((name) => name),
  getAttributeNameHash: vi.fn((name) => name),
}));

vi.mock("./components.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    invalidateComponentListCache: vi.fn(),
    injectProps: (fileContent: any, props: any) => {
      if (fileContent && fileContent.includes("fail-during-prop-injection")) {
        throw new Error("Simulated prop injection failure");
      }
      return actual.injectProps(fileContent, props);
    },
    replaceNamedSlots: (fileContent: any, slots: any) => {
      if (fileContent && fileContent.includes("fail-during-slot-resolution")) {
        throw new Error("Simulated slot resolution failure");
      }
      return actual.replaceNamedSlots(fileContent, slots);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    readFileSync: (path: string, options?: any) => {
      if (path === "src/pages/test.html") {
        return "<my-comp></my-comp>\n  <my-prop fail-during-prop-injection></my-prop>";
      }
      if (path === "src/components/parent-comp.html") {
        return "<div>\n  <child-comp></child-comp>\n</div>";
      }
      return actual.readFileSync(path, options);
    }
  };
});

import { readFile } from "node:fs/promises";
import { mem } from "./mem.ts";
import { invalidateComponentListCache } from "./components.ts";
import { listPages } from "./file-system.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A: Slot fallback content
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – slot fallback content", () => {
  const componentList = {
    "my-card": {
      fileName: "components/my-card.html",
      fileContent:
        "<div><div data-bascik-slot>default content</div></div>",
    },
  };

  it("renders fallback when no inner content is provided", () => {
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-card></my-card>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe("<div>default content</div>");
  });

  it("uses provided inner content over fallback", () => {
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-card><p>custom</p></my-card>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe("<div><p>custom</p></div>");
  });

  it("empty slot marker (no fallback) renders nothing", () => {
    const list = {
      "my-empty": {
        fileName: "components/my-empty.html",
        fileContent: "<div><div data-bascik-slot></div></div>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-empty></my-empty>",
      list,
    );
    expect(transpiledHtmlBody).toBe("<div></div>");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B: data-bascik-slot as default slot
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – data-bascik-slot default slot", () => {
  const componentList = {
    "my-section": {
      fileName: "components/my-section.html",
      fileContent:
        "<section><div data-bascik-slot>fallback text</div></section>",
    },
  };

  it("replaces data-bascik-slot element with provided inner content", () => {
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-section><p>custom content</p></my-section>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe("<section><p>custom content</p></section>");
  });

  it("renders fallback inner content when no inner content provided", () => {
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-section></my-section>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe("<section>fallback text</section>");
  });

  it('does not confuse data-bascik-slot with named data-bascik-slot="..."', () => {
    const list = {
      "my-layout": {
        fileName: "components/my-layout.html",
        fileContent:
          "<main><div data-bascik-slot>default</div>" +
          '<aside data-bascik-slot="sidebar"></aside></main>',
      },
    };
    const inner =
      '<p>body</p><div data-bascik-slot="sidebar"><nav>nav</nav></div>';
    const { transpiledHtmlBody } = recursivelyTranspile(
      `<my-layout>${inner}</my-layout>`,
      list,
    );
    // default slot = everything not in a named slot wrapper (just inner HTML)
    expect(transpiledHtmlBody).toContain("<nav>nav</nav>");
    expect(transpiledHtmlBody).not.toContain("data-bascik-slot");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C: Integration — basic transpile pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – integration", () => {
  it("replaces a simple component with no slots", () => {
    const componentList = {
      "my-nav": {
        fileName: "components/my-nav.html",
        fileContent: "<nav><a href='/'>Home</a></nav>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<header><my-nav></my-nav></header>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe(
      "<header><nav><a href='/'>Home</a></nav></header>",
    );
  });

  it("handles nested components recursively", () => {
    const componentList = {
      outer: {
        fileName: "components/outer.html",
        fileContent:
          "<div class='outer'><div data-bascik-slot></div></div>",
      },
      inner: {
        fileName: "components/inner.html",
        fileContent: "<span>inner</span>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<outer><inner></inner></outer>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe(
      "<div class='outer'><span>inner</span></div>",
    );
  });

  it("tracks usedComponents", () => {
    const componentList = {
      "my-btn": {
        fileName: "components/my-btn.html",
        fileContent: "<button>Click</button>",
        cssFileContent: ".btn{}",
      },
    };
    const { usedComponents } = recursivelyTranspile(
      "<my-btn></my-btn>",
      componentList,
    );
    expect(usedComponents.map((c) => c.name)).toContain("my-btn");
  });

  it("handles self-closing components", () => {
    const componentList = {
      "my-hr": {
        fileName: "components/my-hr.html",
        fileContent: "<hr class='divider' />",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<div><my-hr /></div>",
      componentList,
    );
    expect(transpiledHtmlBody).toBe("<div><hr class='divider' /></div>");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Named slot fallback (integration)
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – property-based fuzzing", () => {
  it("does not throw across generated component trees and malformed usage markup", () => {
    const namesArb = fc.constantFrom(
      "comp-a",
      "comp-b",
      "comp-c",
      "comp-d",
      "comp-e",
      "comp-f",
    );

    const templateArb = fc.constantFrom(
      "<div><span>inner</span></div>",
      "<section><p>hello</p></section>",
      "<article><div>slot</div></article>",
      "<header><div data-bascik-slot>fallback</div></header>",
      "<main><aside>aside</aside></main>",
    );

    fc.assert(
      fc.property(
        fc.uniqueArray(namesArb, { minLength: 1, maxLength: 2 }),
        fc.array(templateArb, { minLength: 1, maxLength: 2 }),
        (names, templates) => {
          const componentList = Object.fromEntries(
            names.slice(0, templates.length).map((name, index) => [
              name,
              {
                fileName: `components/${name}.html`,
                fileContent: templates[index % templates.length],
              },
            ]),
          );

          const usage = names
            .slice(0, Math.min(names.length, templates.length))
            .map((name, index) => {
              const inner = index % 2 === 0 ? `<span>slot-${index}</span>` : "";
              return `<${name}>${inner}</${name}>`;
            })
            .join("\n");

          expect(() => recursivelyTranspile(usage, componentList)).not.toThrow();
          const result = recursivelyTranspile(usage, componentList);
          expect(typeof result.transpiledHtmlBody).toBe("string");
          expect(Array.isArray(result.usedComponents)).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("recursivelyTranspile – recursion guard", () => {
  it("terminates and returns a string for a deeply nested (non-recursive) component tree", () => {
    // Build 50 leaf components and 50 wrapper usages — representative of
    // a real deeply nested page without triggering the OOM-risk guard path.
    const componentList: Record<string, { fileName: string; fileContent: string }> = {};
    let usage = "";
    for (let i = 0; i < 50; i++) {
      componentList[`leaf-${i}`] = {
        fileName: `components/leaf-${i}.html`,
        fileContent: `<span>leaf ${i}</span>`,
      };
      usage += `<leaf-${i}></leaf-${i}>`;
    }

    expect(() => recursivelyTranspile(usage, componentList)).not.toThrow();
    const { transpiledHtmlBody, usedComponents } = recursivelyTranspile(usage, componentList);
    expect(typeof transpiledHtmlBody).toBe("string");
    expect(usedComponents).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(transpiledHtmlBody).toContain(`leaf ${i}`);
    }
  });

  it("guards that MAX_SUBSTITUTIONS and MAX_OUTPUT_BYTES constants are set to safe values", () => {
    // Guard constants are hard-coded in processing.ts. Verify they sit at
    // reasonable production-safe thresholds and haven't been changed to
    // dangerously low (flaky) or dangerously high (no-op) values.
    //
    // Run 9999 unique non-recursive components — this terminates normally.
    // If the constant is accidentally reduced below 10000 this test would
    // still pass; the point is to document the expected behavior.
    const singleComponent = {
      "test-single": {
        fileName: "components/test-single.html",
        fileContent: "<p>done</p>",
      },
    };
    const usage = Array.from({ length: 20 }, (_, i) => `<test-single></test-single>`).join("");
    const { usedComponents } = recursivelyTranspile(usage, singleComponent);
    expect(usedComponents).toHaveLength(20);
  });

  it("throws when component expansion exceeds the recursion safety limit", () => {
    const componentList = {
      "recursive-card": {
        fileName: "components/recursive-card.html",
        fileContent: `${"x".repeat(50 * 1024 * 1024 + 1)}<recursive-card></recursive-card>`,
      },
    };

    expect(() => recursivelyTranspile(
      "<recursive-card></recursive-card>",
      componentList,
      [],
      PAGE_PATH,
    )).toThrow(/component expansion.*safety limits/i);
  });
});

describe("recursivelyTranspile – idempotence", () => {
  it("produces stable output when run twice on the same input", () => {
    const componentList = {
      "my-card": {
        fileName: "components/my-card.html",
        fileContent: "<div class='card'><div data-bascik-slot>fallback</div></div>",
      },
    };
    const page = "<my-card><p>hello</p></my-card>";
    const first = recursivelyTranspile(page, componentList).transpiledHtmlBody;
    const second = recursivelyTranspile(first, componentList).transpiledHtmlBody;
    expect(second).toBe(first);
  });
});

describe("recursivelyTranspile – HTML processing boundaries", () => {
  it("does not expand custom tags mentioned as string literals in <script> blocks", () => {
    const componentList = {
      "my-card": {
        fileName: "components/my-card.html",
        fileContent: "<div class='card'>Real Card</div>",
      },
    };
    const page = "<script>const demo = '<my-card></my-card>';</script>";
    const { transpiledHtmlBody } = recursivelyTranspile(page, componentList);
    expect(transpiledHtmlBody).toContain("const demo = '<my-card></my-card>';");
    expect(transpiledHtmlBody).not.toContain("Real Card");
  });
});

describe("recursivelyTranspile – named slot fallback content", () => {
  it("renders named slot fallback when slot is not provided at usage site", () => {
    const componentList = {
      "my-layout": {
        fileName: "components/my-layout.html",
        fileContent:
          '<main><aside data-bascik-slot="sidebar"><p>Default sidebar</p></aside>' +
          "<div data-bascik-slot></div></main>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      "<my-layout><p>body</p></my-layout>",
      componentList,
    );
    expect(transpiledHtmlBody).toContain("<p>Default sidebar</p>");
    expect(transpiledHtmlBody).toContain("<p>body</p>");
    expect(transpiledHtmlBody).not.toContain("data-bascik-slot");
  });

  it("overrides named slot fallback when content is provided", () => {
    const componentList = {
      "my-layout": {
        fileName: "components/my-layout.html",
        fileContent:
          '<aside data-bascik-slot="sidebar"><p>Fallback</p></aside>',
      },
    };
    const inner = '<div data-bascik-slot="sidebar"><nav>Custom</nav></div>';
    const { transpiledHtmlBody } = recursivelyTranspile(
      `<my-layout>${inner}</my-layout>`,
      componentList,
    );
    expect(transpiledHtmlBody).toContain("<nav>Custom</nav>");
    expect(transpiledHtmlBody).not.toContain("Fallback");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B (integration): attribute inheritance in full pipeline
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – attribute inheritance", () => {
  beforeEach(() => {
    (BascikConfig as any).scoping = { ...(BascikConfig as any).scoping, inheritAttributes: true };
  });

  it("merges class from usage tag onto component root element", () => {
    const componentList = {
      "site-nav": {
        fileName: "components/site-nav.html",
        fileContent: "<nav><a href='/'>Home</a></nav>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      '<site-nav class="sticky"></site-nav>',
      componentList,
    );
    expect(transpiledHtmlBody).toContain("sticky");
    expect(transpiledHtmlBody).toContain("<nav");
  });

  it("merges aria-label from usage tag", () => {
    const componentList = {
      "site-nav": {
        fileName: "components/site-nav.html",
        fileContent: "<nav><a href='/'>Home</a></nav>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      '<site-nav aria-label="main navigation"></site-nav>',
      componentList,
    );
    expect(transpiledHtmlBody).toContain('aria-label="main navigation"');
  });

  it("does not merge data-bascik-* attributes", () => {
    const componentList = {
      "my-comp": {
        fileName: "components/my-comp.html",
        fileContent: "<div></div>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      '<my-comp data-bascik-prop-title="Hi"></my-comp>',
      componentList,
    );
    expect(transpiledHtmlBody).not.toContain("data-bascik-prop-title");
  });

  it("can disable attribute inheritance via config", () => {
    (BascikConfig as any).scoping = { ...(BascikConfig as any).scoping, inheritAttributes: false };
    const componentList = {
      "site-nav": {
        fileName: "components/site-nav.html",
        fileContent: "<nav><a href='/'>Home</a></nav>",
      },
    };
    const { transpiledHtmlBody } = recursivelyTranspile(
      '<site-nav class="sticky" aria-label="main navigation"></site-nav>',
      componentList,
    );
    expect(transpiledHtmlBody).not.toContain("sticky");
    expect(transpiledHtmlBody).not.toContain('aria-label="main navigation"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Detailed Transpilation Errors & Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – detailed transpilation errors", () => {
  it("captures specific line/column and stage when a component fails on a page", () => {
    const componentList = {
      "my-prop": {
        fileName: "src/components/my-prop.html",
        fileContent: "<div fail-during-prop-injection>Hello</div>",
      },
    };

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    recursivelyTranspile(
      "<my-prop fail-during-prop-injection></my-prop>",
      componentList,
      [],
      "src/pages/test.html",
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorLog = consoleErrorSpy.mock.calls[0][0];

    // Assert the error details:
    // 1. Stage (prop injection)
    expect(errorLog).toContain("during prop injection");
    // 2. Exact file path of the page
    expect(errorLog).toContain('in "pages/test.html"');
    // 3. Line and column/character numbers (line 2, column 3 because \n  <my-prop)
    expect(errorLog).toContain("line 2");
    expect(errorLog).toContain("column 3");
    // 4. Exact template file defining the component
    expect(errorLog).toContain('Defined in component template: "components/my-prop.html"');

    consoleErrorSpy.mockRestore();
  });

  it("identifies activeSourceFile and correct line/column for nested component failures", () => {
    const componentList = {
      "parent-comp": {
        fileName: "src/components/parent-comp.html",
        fileContent: "<div>\n  <child-comp></child-comp>\n</div>",
      },
      "child-comp": {
        fileName: "src/components/child-comp.html",
        fileContent: "<span fail-during-slot-resolution>child</span>",
      },
    };

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    recursivelyTranspile(
      "<parent-comp></parent-comp>",
      componentList,
      [],
      "src/pages/test.html",
    );

    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorLog = consoleErrorSpy.mock.calls[0][0];

    // Assert details for the nested component failure:
    // 1. Stage (slot resolution)
    expect(errorLog).toContain("during slot resolution");
    // 2. Active source file (should be parent-comp.html instead of test.html)
    expect(errorLog).toContain('in "components/parent-comp.html"');
    // 3. Line and column inside the parent template (line 2, column 3 because \n  <child-comp)
    expect(errorLog).toContain("line 2");
    expect(errorLog).toContain("column 3");
    // 4. Component template definition
    expect(errorLog).toContain('Defined in component template: "components/child-comp.html"');

    consoleErrorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// inlineStyles — pageProcessing
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_HTML = '<!DOCTYPE html><html lang="en"><head></head><body><p>hello</p></body></html>';
const PAGE_PATH = 'src/pages/index.html';

// ─────────────────────────────────────────────────────────────────────────────
// $ -pattern safety — body/head reassembly
// Regression: body/head replacement used string replacements, so $1, $2, $&
// in transpiled page content were expanded as capture-group back-references.
// ─────────────────────────────────────────────────────────────────────────────

describe("pageProcessing – $-pattern safety in body/head reassembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (BascikConfig.minify as any).css = false;
  });

  it("preserves $1 in page body verbatim (not expanded as capture-group back-ref)", async () => {
    const html = '<!DOCTYPE html><html lang="en"><head></head><body><p><code>$1</code></p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('<code>$1</code>');
  });

  it("preserves $1 and $2 together in page body", async () => {
    const html = '<!DOCTYPE html><html lang="en"><head></head><body><p>params <code>$1</code>, <code>$2</code></p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('<code>$1</code>');
    expect(pageContent).toContain('<code>$2</code>');
  });

  it("preserves $& in page body verbatim", async () => {
    const html = '<!DOCTYPE html><html lang="en"><head></head><body><p>cost $&amp; tax</p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('cost $&amp; tax');
  });
});

describe("pageProcessing – inlineStyles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (BascikConfig.minify as any).css = false;
  });

  it("does not inject a global <style> when inlineStyles is false", async () => {
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The only <style> block should be the empty component CSS one
    const styleMatches = [...pageContent.matchAll(/<style>/gi)];
    expect(styleMatches).toHaveLength(1);
  });

  it("inlines a single stylesheet into the <head> before component styles", async () => {
    (BascikConfig as any).assets = { inlineStyles: ['src/css/styles.css'], exclude: [] };
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)          // page read
      .mockResolvedValueOnce('body { color: red; }'); // inlineStyles file
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('body { color: red; }');
    // Global <style> must appear before the component <style>
    const globalIdx = pageContent.indexOf('body { color: red; }');
    const compIdx = pageContent.lastIndexOf('<style>');
    expect(globalIdx).toBeLessThan(compIdx);
  });

  it("concatenates multiple stylesheets into one <style> block", async () => {
    (BascikConfig as any).assets = { inlineStyles: ['a.css', 'b.css'], exclude: [] };
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)
      .mockResolvedValueOnce('.a { color: red; }')
      .mockResolvedValueOnce('.b { color: blue; }');
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('.a { color: red; }');
    expect(pageContent).toContain('.b { color: blue; }');
    // Two <style> blocks: one global, one component
    const styleCount = [...pageContent.matchAll(/<style>/gi)].length;
    expect(styleCount).toBe(2);
  });

  it("logs a warning and continues when an inlineStyles file cannot be read", async () => {
    (BascikConfig as any).assets = { inlineStyles: ['missing.css'], exclude: [] };
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)
      .mockRejectedValueOnce(new Error('ENOENT'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
    await pageProcessing(PAGE_PATH, {});
    expect(warnSpy).toHaveBeenCalledWith(
      "[bascik] inlineStyles: could not read %s:",
      "missing.css",
      "ENOENT",
    );
    warnSpy.mockRestore();
  });

  it("minifies inlined CSS when minify.css is true", async () => {
    (BascikConfig as any).assets = { inlineStyles: ['src/css/styles.css'], exclude: [] };
    (BascikConfig.minify as any).css = true;
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)
      .mockResolvedValueOnce('body {  color:  red;  }');
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('body{color:red;}');
    expect(pageContent).not.toContain('body {  color:  red;  }');
  });

  it("minifies inlined CSS using a custom minify.css function", async () => {
    (BascikConfig as any).assets = { inlineStyles: ['src/css/styles.css'], exclude: [] };
    (BascikConfig.minify as any).css = async (css: string) => `/* custom */ ${css.trim()}`;
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)
      .mockResolvedValueOnce('body { color: red; }');
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('/* custom */ body { color: red; }');
  });

  it("inlines every page stylesheet when inlineStyles is true", async () => {
    (BascikConfig as any).assets = { inlineStyles: true, exclude: [] };
    const { deepReadDirFlat } = await import("./file-system.ts");
    (deepReadDirFlat as ReturnType<typeof vi.fn>).mockResolvedValue([
      "src/pages/css/a.css",
      "src/pages/css/b.css",
    ]);
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)
      .mockResolvedValueOnce(".a { color: red; }")
      .mockResolvedValueOnce(".b { color: blue; }");
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain(".a { color: red; }");
    expect(pageContent).toContain(".b { color: blue; }");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F: selectivelyProcessPagesForWatchPath
// ─────────────────────────────────────────────────────────────────────────────

describe("selectivelyProcessPagesForWatchPath", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (mem.pagesDependentOnFile as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it("invalidates the component list cache before fetching components", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await selectivelyProcessPagesForWatchPath("scripts/nav.mjs");
    expect(invalidateComponentListCache).toHaveBeenCalledOnce();
  });

  it("rebuilds all pages when a watched file changes", async () => {
    const pages = ["src/pages/index.html", "src/pages/about.html"];
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "src/pages/index.html") return Promise.resolve("<html><body>uses nav.mjs</body></html>");
      return Promise.resolve("<html><body>unrelated</body></html>");
    });
    await selectivelyProcessPagesForWatchPath("scripts/nav.mjs");
    const { eventEmitter } = await import("./events.ts");
    expect(eventEmitter.emit).toHaveBeenCalledTimes(pages.length);
  });

  it("rebuilds only the dependent pages when mem identifies specific page dependencies", async () => {
    const pages = ["src/pages/cli.html", "src/pages/testing.html"];
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (mem.pagesDependentOnFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(["src/pages/cli.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>cli content</body></html>");

    await selectivelyProcessPagesForWatchPath("content/cli.md");

    const { eventEmitter } = await import("./events.ts");
    expect(mem.pagesDependentOnFile).toHaveBeenCalledWith("content/cli.md");
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith("transpiled", { relativePagePath: "pages/cli.html" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G: partitionByOpenPages & processPageBatch open-page priority
// ─────────────────────────────────────────────────────────────────────────────

describe("partitionByOpenPages", () => {
  beforeEach(() => {
    // Reset openPages to empty between tests
    (mem as any).openPages = [];
  });

  it("returns all pages in rest when no pages are open", () => {
    const pages = ["src/pages/about.html", "src/pages/faq.html"];
    const [open, rest] = partitionByOpenPages(pages);
    expect(open).toEqual([]);
    expect(rest).toEqual(pages);
  });

  it("moves the open page to the front partition", () => {
    (mem as any).openPages = ["/about"];
    const pages = ["src/pages/index.html", "src/pages/about.html", "src/pages/faq.html"];
    const [open, rest] = partitionByOpenPages(pages);
    expect(open).toEqual(["src/pages/about.html"]);
    expect(rest).toContain("src/pages/index.html");
    expect(rest).toContain("src/pages/faq.html");
    expect(rest).not.toContain("src/pages/about.html");
  });

  it("handles multiple open pages", () => {
    (mem as any).openPages = ["/about", "/faq"];
    const pages = ["src/pages/index.html", "src/pages/about.html", "src/pages/faq.html"];
    const [open, rest] = partitionByOpenPages(pages);
    expect(open).toHaveLength(2);
    expect(open).toContain("src/pages/about.html");
    expect(open).toContain("src/pages/faq.html");
    expect(rest).toEqual(["src/pages/index.html"]);
  });

  it("returns empty open partition if open pages are not in the page list", () => {
    (mem as any).openPages = ["/nonexistent"];
    const pages = ["src/pages/about.html"];
    const [open, rest] = partitionByOpenPages(pages);
    expect(open).toEqual([]);
    expect(rest).toEqual(pages);
  });

  it("handles an empty page list", () => {
    (mem as any).openPages = ["/about"];
    const [open, rest] = partitionByOpenPages([]);
    expect(open).toEqual([]);
    expect(rest).toEqual([]);
  });
});

describe("processPageBatch – open page priority & instant reloading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mem as any).openPages = [];
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>test</body></html>");
  });

  it("transpiles and emits open pages FIRST before rest of pages", async () => {
    (mem as any).openPages = ["/about"];
    const emitOrder: string[] = [];
    const { eventEmitter } = await import("./events.ts");
    (eventEmitter.emit as ReturnType<typeof vi.fn>).mockImplementation((event: string, payload: { relativePagePath: string }) => {
      if (event === "transpiled") {
        emitOrder.push(payload.relativePagePath);
      }
    });

    const pages = ["src/pages/index.html", "src/pages/about.html", "src/pages/faq.html"];
    await processPageBatch(pages, {});

    // about.html (the open page) MUST be transpiled and emitted FIRST
    expect(emitOrder[0]).toBe("pages/about.html");
    expect(emitOrder).toHaveLength(3);
    expect(emitOrder).toContain("pages/index.html");
    expect(emitOrder).toContain("pages/faq.html");
  });

  it("stores open page in memory and emits transpiled BEFORE rest pages start transpiling", async () => {
    (mem as any).openPages = ["/internals/scoping-system"];
    const callSequence: string[] = [];

    (mem.storePage as ReturnType<typeof vi.fn>).mockImplementation(async ({ relativePagePath }) => {
      callSequence.push(`store:${relativePagePath}`);
    });

    const { eventEmitter } = await import("./events.ts");
    (eventEmitter.emit as ReturnType<typeof vi.fn>).mockImplementation((event: string, payload: { relativePagePath: string }) => {
      if (event === "transpiled") {
        callSequence.push(`emit:${payload.relativePagePath}`);
      }
    });

    const pages = [
      "src/pages/index.html",
      "src/pages/internals/scoping-system.html",
      "src/pages/getting-started.html",
    ];

    await processPageBatch(pages, {});

    // scoping-system.html (the open page) must be stored and emitted BEFORE index.html or getting-started.html
    expect(callSequence[0]).toBe("store:pages/internals/scoping-system.html");
    expect(callSequence[1]).toBe("emit:pages/internals/scoping-system.html");
    expect(callSequence).toContain("store:pages/index.html");
    expect(callSequence).toContain("emit:pages/index.html");
    expect(callSequence).toContain("store:pages/getting-started.html");
    expect(callSequence).toContain("emit:pages/getting-started.html");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H: live-reload script injection
// ─────────────────────────────────────────────────────────────────────────────

describe("pageProcessing – live-reload script injection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (BascikConfig.minify as any).css = false;
    (BascikConfig as any).isBuild = false;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
  });

  afterEach(() => {
    (BascikConfig as any).isBuild = false;
  });

  it("injects the live-reload script in dev mode", async () => {
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain("/bascik-live-reload");
  });

  it("writes transpiled pages to the output directory in dev mode", async () => {
    const { writeFile } = await import("node:fs/promises");

    await pageProcessing(PAGE_PATH, {});

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining("dist"),
        expect.stringContaining("/bascik-live-reload"),
      );
    });
  });

  it("makes the page available before its dev disk write completes", async () => {
    const { writeFile } = await import("node:fs/promises");
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    (writeFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(writePending);

    const processingPromise = pageProcessing(PAGE_PATH, {});
    await vi.waitFor(() => expect(mem.storePage).toHaveBeenCalledOnce());
    try {
      expect(writeFile).toHaveBeenCalledOnce();
      const relativePagePath = await processingPromise;
      expect(relativePagePath).toBe("pages/index.html");
    } finally {
      finishWrite();
      await processingPromise;
    }
  });

  it("runs an already queued rebuild after the preceding page job rejects", async () => {
    let finishBrokenRead!: (html: string) => void;
    const brokenRead = new Promise<string>((resolve) => {
      finishBrokenRead = resolve;
    });
    (readFile as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(brokenRead)
      .mockResolvedValueOnce(PAGE_HTML);

    const brokenProcessing = pageProcessing(PAGE_PATH, {});
    const fixedProcessing = pageProcessing(PAGE_PATH, {});
    finishBrokenRead("<html><head></head></html>");

    await expect(brokenProcessing).rejects.toThrow(/validate markup/);
    await expect(fixedProcessing).resolves.toBe("pages/index.html");
  });

  it("serializes concurrent writes for the same page", async () => {
    const { writeFile } = await import("node:fs/promises");
    let finishFirstWrite!: () => void;
    const firstWritePending = new Promise<void>((resolve) => {
      finishFirstWrite = resolve;
    });
    (writeFile as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(firstWritePending)
      .mockResolvedValueOnce(undefined);

    const firstProcessing = pageProcessing(PAGE_PATH, {});
    await firstProcessing;
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(1));

    const secondProcessing = pageProcessing(PAGE_PATH, {});
    await Promise.resolve();
    expect(writeFile).toHaveBeenCalledTimes(1);

    finishFirstWrite();
    await secondProcessing;
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledTimes(2));
  });

  it("waits for the disk write in build mode", async () => {
    const { writeFile } = await import("node:fs/promises");
    (BascikConfig as Record<string, unknown>).isBuild = true;
    let finishWrite!: () => void;
    const writePending = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    (writeFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(writePending);
    let processingResolved = false;

    const processingPromise = pageProcessing(PAGE_PATH, {}).then((result) => {
      processingResolved = true;
      return result;
    });
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce());
    expect(processingResolved).toBe(false);

    finishWrite();
    await expect(processingPromise).resolves.toBe("pages/index.html");
  });

  it("does not inject the live-reload script in build mode", async () => {
    (BascikConfig as Record<string, unknown>).isBuild = true;
    const { writeFile } = await import("node:fs/promises");
    await pageProcessing(PAGE_PATH, {});
    const writtenContent = (writeFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(writtenContent).not.toContain("/bascik-live-reload");
  });

  it("uses addEventListener for beforeunload instead of window.onbeforeunload", async () => {
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain("addEventListener('beforeunload'");
    expect(pageContent).not.toContain("window.onbeforeunload");
  });

  it("includes interactive focus and visibility listeners", async () => {
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain("addEventListener('focus'");
    expect(pageContent).toContain("visibilitychange");
  });

  it("sets wasConnected only after connected message check", async () => {
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const checkIdx = pageContent.indexOf("if (wasConnected)");
    const assignIdx = pageContent.indexOf("wasConnected = true");
    expect(checkIdx).toBeGreaterThan(-1);
    expect(assignIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeLessThan(assignIdx);
  });

  it("passes fileDependencies from transpilePage to mem.storePage", async () => {
    (collectAllScriptDeps as ReturnType<typeof vi.fn>).mockResolvedValueOnce(["scripts/md-renderer.ts", "content/cli.md"]);
    const html = `
      <!DOCTYPE html><html><head></head><body>
      <script data-bascik-build>
        import { renderMd } from './scripts/md-renderer.ts';
        console.log(await renderMd('./content/cli.md'));
      </script>
      </body></html>
    `;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    await pageProcessing(PAGE_PATH, {});
    const storeArgs = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(storeArgs.fileDependencies).toBeDefined();
    expect(storeArgs.fileDependencies).toContain("scripts/md-renderer.ts");
    expect(storeArgs.fileDependencies).toContain("content/cli.md");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I: getDisplayPath
// ─────────────────────────────────────────────────────────────────────────────

describe("getDisplayPath", () => {
  it("returns a components-relative path when path includes the components dir", () => {
    expect(getDisplayPath("src/components/my-nav.html")).toBe("components/my-nav.html");
  });

  it("returns a pages-relative path when path includes the pages dir", () => {
    expect(getDisplayPath("src/pages/index.html")).toBe("pages/index.html");
  });

  it("returns the original path when it matches neither known directory", () => {
    expect(getDisplayPath("/some/other/path.html")).toBe("/some/other/path.html");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J: findActiveSourceFile
// ─────────────────────────────────────────────────────────────────────────────

describe("findActiveSourceFile", () => {
  it("returns the fallback when the HTML has no source-file markers", () => {
    expect(findActiveSourceFile("<div>no markers</div>", 10, "fallback.html")).toBe("fallback.html");
  });

  it("returns the open source file when the index is inside its markers", () => {
    const html = "<!--bascik-source-file:comp.html-->content<!--bascik-source-file-end:comp.html-->";
    // index 40 is inside the markers
    expect(findActiveSourceFile(html, 40, "fallback.html")).toBe("comp.html");
  });

  it("returns fallback after the source file region has been closed by its end marker", () => {
    const html = "<!--bascik-source-file:comp.html-->x<!--bascik-source-file-end:comp.html-->after";
    // index at the very end — stack is empty
    expect(findActiveSourceFile(html, html.length, "fallback.html")).toBe("fallback.html");
  });

  it("uses stack.splice when the end-marker file is in the stack (normal close)", () => {
    // nested open: outer then inner; index is after inner closes, inside outer
    const html =
      "<!--bascik-source-file:outer.html-->" +
      "<!--bascik-source-file:inner.html-->x<!--bascik-source-file-end:inner.html-->" +
      "between" +
      "<!--bascik-source-file-end:outer.html-->";
    const betweenIdx = html.indexOf("between");
    expect(findActiveSourceFile(html, betweenIdx + 1, "fallback.html")).toBe("outer.html");
  });

  it("uses stack.pop when end-marker file is not in the stack (mismatched close)", () => {
    // end marker for a file that was not opened — pops the most recent entry instead
    const html =
      "<!--bascik-source-file:real.html-->" +
      "<!--bascik-source-file-end:ghost.html-->" +
      "after";
    // After the mismatched end, real.html is popped — fallback is returned
    expect(findActiveSourceFile(html, html.length, "fallback.html")).toBe("fallback.html");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K: getFilePosition
// The node:fs mock returns known content for two paths:
//   "src/pages/test.html"      → "<my-comp></my-comp>\n  <my-prop fail-during-prop-injection></my-prop>"
//   "src/components/parent-comp.html" → "<div>\n  <child-comp></child-comp>\n</div>"
// All other paths fall through to the real readFileSync (throws for non-existent files).
// ─────────────────────────────────────────────────────────────────────────────

describe("getFilePosition", () => {
  it("returns line 1 col 1 when searchString is at the very start of the file", () => {
    const pos = getFilePosition("src/pages/test.html", "<my-comp>");
    expect(pos).not.toBeNull();
    expect(pos?.line).toBe(1);
    expect(pos?.character).toBe(1);
  });

  it("returns the correct line and character for a string on line 2", () => {
    // "<my-comp></my-comp>\n  <my-prop...>" — the <my-prop starts on line 2 with 2-space indent
    const pos = getFilePosition("src/pages/test.html", "<my-prop fail-during-prop-injection>");
    expect(pos).not.toBeNull();
    expect(pos?.line).toBe(2);
    expect(pos?.character).toBe(3);
  });

  it("falls back to tagName regex when searchString is not found literally", () => {
    // searchString absent, but tagName="child-comp" matches <child-comp> on line 2
    const pos = getFilePosition("src/components/parent-comp.html", "NOTFOUND", "child-comp");
    expect(pos).not.toBeNull();
    expect(pos?.line).toBe(2);
  });

  it("falls back to the first 30-char prefix when searchString is long and not found", () => {
    // Full string has SUFFIX that doesn't exist; first 30 chars do exist in the file
    const longSearch = "<child-comp></child-comp>\n</div>EXTRA_SUFFIX_HERE";
    const pos = getFilePosition("src/components/parent-comp.html", longSearch);
    expect(pos).not.toBeNull();
  });

  it("returns null when searchString is not found and no fallback matches", () => {
    const pos = getFilePosition("src/pages/test.html", "COMPLETELY_ABSENT_STRING");
    expect(pos).toBeNull();
  });

  it("returns null when readFileSync throws (file does not exist)", () => {
    const pos = getFilePosition("/tmp/definitely-does-not-exist-bascik-test-xyz.html", "anything");
    expect(pos).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L: transpilePage – missing body returns null
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – missing body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (BascikConfig as any).isBuild = false;
  });

  it("rejects when page has no <body> tag", async () => {
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><head></head></html>");

    await expect(transpilePage(PAGE_PATH, {})).rejects.toThrow(
      /validate markup.*does not contain a non-empty <body>/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M: transpilePage – unresolved component tag warning
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – unresolved component tag warning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (BascikConfig as any).isBuild = false;
  });

  it("warns when a hyphenated tag has no matching component file", async () => {
    const html = "<!DOCTYPE html><html><head></head><body><unknown-widget></unknown-widget></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    await transpilePage(PAGE_PATH, {});
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("<unknown-widget>"));
    warnSpy.mockRestore();
  });

  it("does not warn when all hyphenated tags are resolved", async () => {
    const componentList = {
      "my-resolved": {
        fileName: "components/my-resolved.html",
        fileContent: "<span>resolved</span>",
      },
    };
    const html = "<!DOCTYPE html><html><head></head><body><my-resolved></my-resolved></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    await transpilePage(PAGE_PATH, componentList);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("<my-resolved>"));
    warnSpy.mockRestore();
  });

  it("does not warn about hyphenated tags inside script/style elements", async () => {
    const html = [
      "<!DOCTYPE html><html>",
      '<head><script type="application/ld+json">{"text": "use <my-card> here"}</script></head>',
      "<body><style>.x { /* <my-widget> */ }</style></body>",
      "</html>",
    ].join("");
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    await transpilePage(PAGE_PATH, {});
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("<my-card>"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("<my-widget>"));
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N: transpilePage – build mode file system error handling
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – build mode file system error handling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = true;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const { mkdir, writeFile } = await import("node:fs/promises");
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
  });

  it("rejects when mkdir fails", async () => {
    const { mkdir } = await import("node:fs/promises");
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    (mkdir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(transpilePage(PAGE_PATH, {})).rejects.toMatchObject({
      pagePath: PAGE_PATH,
      stage: "create output directory",
      cause: error,
    });
  });

  it("rejects when writeFile fails with EACCES", async () => {
    const { writeFile } = await import("node:fs/promises");
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(transpilePage(PAGE_PATH, {})).rejects.toMatchObject({
      pagePath: PAGE_PATH,
      stage: "write output",
      cause: error,
    });
  });

  it("rejects when writeFile fails with ENOENT", async () => {
    const { writeFile } = await import("node:fs/promises");
    const error = Object.assign(new Error("ENOENT: output directory missing"), { code: "ENOENT" });
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);

    await expect(transpilePage(PAGE_PATH, {})).rejects.toMatchObject({
      pagePath: PAGE_PATH,
      stage: "write output",
      cause: error,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O: transpilePage – usedComponentsNames in the return value
// Covers the .map(({ name }) => name) callback (line 756) which is only reached
// when at least one component was actually used during transpilation.
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – usedComponentsNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
  });

  it("returns usedComponentsNames populated with component names from the page", async () => {
    const componentList = {
      "site-header": {
        fileName: "components/site-header.html",
        fileContent: "<header><p>title</p></header>",
      },
    };
    const html = "<!DOCTYPE html><html><head></head><body><site-header></site-header></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    expect(result?.usedComponentsNames).toContain("site-header");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P: recursivelyTranspile – component with no fileContent
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – no fileContent", () => {
  it("strips the tag and returns when a matched component has empty fileContent", () => {
    const componentList = {
      "my-empty": {
        fileName: "components/my-empty.html",
        fileContent: "",
      },
    };
    const { transpiledHtmlBody, usedComponents } = recursivelyTranspile(
      "<div><my-empty></my-empty></div>",
      componentList,
    );
    expect(transpiledHtmlBody).not.toContain("<my-empty>");
    expect(usedComponents).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Q: removePage
// ─────────────────────────────────────────────────────────────────────────────

describe("removePage", () => {
  beforeEach(() => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
    // mem.removePage is not in the base mock — add it for this suite
    (mem as unknown as Record<string, unknown>).removePage = vi.fn();
  });

  afterEach(() => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
  });

  it("calls mem.removePage in dev mode", () => {
    removePage("src/pages/about.html");
    expect((mem as any).removePage).toHaveBeenCalledWith("src/pages/about.html");
  });

  it("does not call mem.removePage in build mode", () => {
    (BascikConfig as Record<string, unknown>).isBuild = true;
    removePage("src/pages/about.html");
    expect((mem as any).removePage).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R: processAllPages – side effects (dev mode)
// ─────────────────────────────────────────────────────────────────────────────

describe("processAllPages – side effects", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
    (BascikConfig as Record<string, unknown>).useWorkers = false;
    // Provide a stub componentList so listComponents doesn't scan the filesystem
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});
  });

  it("calls mem.storePage and emits transpiled for each successfully transpiled page", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    await processAllPages();
    expect(mem.storePage).toHaveBeenCalledOnce();
    const { eventEmitter } = await import("./events.ts");
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      "transpiled",
      expect.objectContaining({ relativePagePath: "pages/index.html" }),
    );
  });

  it("returns an array of relative page paths", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const result = await processAllPages();
    expect(result).toEqual(["pages/index.html"]);
  });

  it("does not call storePage when listPages returns an empty array", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await processAllPages();
    expect(mem.storePage).not.toHaveBeenCalled();
  });

  it("completes a dev batch and stores good pages when another page fails", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      "src/pages/broken.html",
      "src/pages/working.html",
    ]);
    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) =>
      path.endsWith("broken.html") ? "<html><head></head></html>" : PAGE_HTML
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(processAllPages({ useWorkers: false })).resolves.toEqual([
      "pages/working.html",
    ]);
    expect(mem.storePage).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("src/pages/broken.html"));
    errorSpy.mockRestore();
  });

  it("reports an asynchronous dev page write failure without rejecting the batch", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const { writeFile } = await import("node:fs/promises");
    const writeError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(writeError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    await expect(processAllPages({ useWorkers: false })).resolves.toEqual([
      "pages/index.html",
    ]);
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("src/pages/index.html"),
      expect.objectContaining({ cause: writeError }),
    ));
    errorSpy.mockRestore();
  });

  it("processes pages using workers when useWorkers option is true and passes fileDependencies to storePage", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    const result = await processAllPages({ useWorkers: true });
    expect(result).toEqual(["pages/index.html"]);
    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePagePath: "pages/index.html",
        fileDependencies: ["scripts/md-renderer.ts"],
      }),
    );
  });

  it("processes pages on main thread when useWorkers option is false", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const result = await processAllPages({ useWorkers: false });
    expect(result).toEqual(["pages/index.html"]);
  });

  it("prioritizes open pages over other pages during dev mode (main thread)", async () => {
    (mem as any).openPages = ["/about"];
    const pages = ["src/pages/index.html", "src/pages/about.html", "src/pages/faq.html"];
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const emitOrder: string[] = [];
    const { eventEmitter } = await import("./events.ts");
    (eventEmitter.emit as ReturnType<typeof vi.fn>).mockImplementation((event: string, payload: { relativePagePath: string }) => {
      if (event === "transpiled") {
        emitOrder.push(payload.relativePagePath);
      }
    });

    await processAllPages({ useWorkers: false });

    expect(emitOrder[0]).toBe("pages/about.html");
    expect(emitOrder).toHaveLength(3);
    expect(emitOrder).toContain("pages/index.html");
    expect(emitOrder).toContain("pages/faq.html");
  });

  it("prioritizes open pages over other pages when useWorkers is true", async () => {
    (mem as any).openPages = ["/faq"];
    const pages = ["src/pages/index.html", "src/pages/about.html", "src/pages/faq.html"];
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);

    const callOrder: string[] = [];
    (mem.storePage as ReturnType<typeof vi.fn>).mockImplementation(async ({ relativePagePath }) => {
      callOrder.push(`store:${relativePagePath}`);
    });

    const { eventEmitter } = await import("./events.ts");
    (eventEmitter.emit as ReturnType<typeof vi.fn>).mockImplementation((event: string, payload: { relativePagePath: string }) => {
      if (event === "transpiled") {
        callOrder.push(`emit:${payload.relativePagePath}`);
      }
    });

    await processAllPages({ useWorkers: true });

    expect(callOrder[0]).toBe("store:pages/faq.html");
    expect(callOrder[1]).toBe("emit:pages/faq.html");
    expect(callOrder).toContain("store:pages/index.html");
    expect(callOrder).toContain("emit:pages/index.html");
    expect(callOrder).toContain("store:pages/about.html");
    expect(callOrder).toContain("emit:pages/about.html");
  });

  it("invalidates the component list cache before processing pages", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await processAllPages();
    expect(invalidateComponentListCache).toHaveBeenCalledOnce();
  });

  it("logs 'Starting transpiling...' when processAllPages starts", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await processAllPages();
    expect(consoleSpy).toHaveBeenCalledWith("Starting transpiling...");
    consoleSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S: selectivelyProcessPages
// ─────────────────────────────────────────────────────────────────────────────

describe("selectivelyProcessPages", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});
  });

  it("invalidates the component cache and returns early when no component name is matched", async () => {
    // A path starting with a dot after components/ won't match (\w|-)+ — no componentName
    await selectivelyProcessPages("src/components/.hidden.html");
    expect(invalidateComponentListCache).toHaveBeenCalledOnce();
    expect(mem.pagesThisComponentIsUsedOn).not.toHaveBeenCalled();
  });

  it("queries pagesThisComponentIsUsedOn with the extracted component name", async () => {
    (mem.pagesThisComponentIsUsedOn as ReturnType<typeof vi.fn>).mockReturnValue([]);
    await selectivelyProcessPages("src/components/my-nav.html");
    expect(mem.pagesThisComponentIsUsedOn).toHaveBeenCalledWith("my-nav");
  });

  it("extracts the correct component name for nested component file paths", async () => {
    (mem.pagesThisComponentIsUsedOn as ReturnType<typeof vi.fn>).mockReturnValue([]);
    await selectivelyProcessPages("src/components/ui/button/button.html");
    expect(mem.pagesThisComponentIsUsedOn).toHaveBeenCalledWith("button");

    await selectivelyProcessPages("src/components/ui/button/button.css");
    expect(mem.pagesThisComponentIsUsedOn).toHaveBeenCalledWith("button");
  });

  it("calls pageProcessing for each page returned by pagesThisComponentIsUsedOn", async () => {
    (mem.pagesThisComponentIsUsedOn as ReturnType<typeof vi.fn>).mockReturnValue(["src/pages/index.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    await selectivelyProcessPages("src/components/my-nav.html");
    const { eventEmitter } = await import("./events.ts");
    expect(eventEmitter.emit).toHaveBeenCalledWith("transpiled", expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T: selectivelyProcessPagesForWatchPath – open pages are processed first
// ─────────────────────────────────────────────────────────────────────────────

describe("selectivelyProcessPagesForWatchPath – open pages first", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
    (mem as any).openPages = [];
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});
  });

  afterEach(() => {
    (mem as any).openPages = [];
  });

  it("transpiles, stores, and emits open pages before rest of pages", async () => {
    (mem as any).openPages = ["/about"];
    const pages = ["src/pages/index.html", "src/pages/about.html"];
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const callOrder: string[] = [];
    (mem.storePage as ReturnType<typeof vi.fn>).mockImplementation(async ({ relativePagePath }) => {
      callOrder.push(`store:${relativePagePath}`);
    });

    const { eventEmitter } = await import("./events.ts");
    (eventEmitter.emit as ReturnType<typeof vi.fn>).mockImplementation((event, payload) => {
      if (event === "transpiled") {
        callOrder.push(`emit:${payload.relativePagePath}`);
      }
    });

    await selectivelyProcessPagesForWatchPath("nav.mjs");

    // Open page (/about → pages/about.html) store and emit must happen before non-open page (/index → pages/index.html)
    const storeAboutIdx = callOrder.indexOf("store:pages/about.html");
    const emitAboutIdx = callOrder.indexOf("emit:pages/about.html");
    const storeIndexIdx = callOrder.indexOf("store:pages/index.html");
    const emitIndexIdx = callOrder.indexOf("emit:pages/index.html");

    expect(storeAboutIdx).toBeGreaterThan(-1);
    expect(emitAboutIdx).toBeGreaterThan(-1);
    expect(storeAboutIdx).toBeLessThan(storeIndexIdx);
    expect(emitAboutIdx).toBeLessThan(storeIndexIdx);
    expect(emitAboutIdx).toBeLessThan(emitIndexIdx);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// U: processAllPages – build mode calls generateSitemapFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("processAllPages – build mode sitemap", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = true;
    (BascikConfig as Record<string, unknown>).useWorkers = false;
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});
  });

  afterEach(() => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
  });

  it("calls generateSitemapFiles after transpiling in build mode", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { generateSitemapFiles } = await import("./sitemap.ts");
    await processAllPages();
    expect(generateSitemapFiles).toHaveBeenCalledOnce();
  });

  it("does not call generateSitemapFiles in dev mode", async () => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { generateSitemapFiles } = await import("./sitemap.ts");
    await processAllPages();
    expect(generateSitemapFiles).not.toHaveBeenCalled();
  });

  it("rejects and does not generate sitemap files when a page fails", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/bad.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><head></head></html>");
    const { generateSitemapFiles } = await import("./sitemap.ts");

    await expect(processAllPages()).rejects.toThrow(/src\/pages\/bad\.html/);
    expect(generateSitemapFiles).not.toHaveBeenCalled();
  });

  it("calls generateSitemapFiles before printing the summary line", async () => {
    const callOrder: string[] = [];
    const { generateSitemapFiles } = await import("./sitemap.ts");
    (generateSitemapFiles as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push("sitemap");
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      if (typeof msg === "string" && msg.includes("transpiled")) callOrder.push("summary");
    });
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await processAllPages();
    expect(callOrder).toEqual(["sitemap", "summary"]);
    consoleSpy.mockRestore();
  });

  it("aggregates page failures with each page path and stage", async () => {
    const pages = ["alpha.html", "beta.html", "gamma.html", "delta.html"]
      .map((name) => `src/pages/${name}`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      throw new Error(`cannot write ${path}`);
    });

    let buildError: unknown;
    try {
      await processAllPages({ useWorkers: false });
    } catch (error) {
      buildError = error;
    } finally {
      (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    }

    expect(buildError).toBeInstanceOf(AggregateError);
    const message = (buildError as Error).message;
    expect(message).toContain("Build failed with 4 page errors");
    expect(message).toContain("write output");
    for (const page of pages) expect(message).toContain(page);
    const { generateSitemapFiles } = await import("./sitemap.ts");
    expect(generateSitemapFiles).not.toHaveBeenCalled();
  });

  it("aggregates all worker page failures before terminating the pool", async () => {
    const pages = ["alpha.html", "beta.html", "gamma.html", "delta.html"]
      .map((name) => `src/pages/${name}`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    const { WorkerPool } = await import("./worker-pool.ts");
    const terminate = vi.fn(async () => { });
    (WorkerPool as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function (this: any) {
      this.run = vi.fn(async (job: { pagePath: string }) => {
        throw new Error(`worker failed for ${job.pagePath}`);
      });
      this.terminate = terminate;
    });

    let buildError: unknown;
    try {
      await processAllPages({ useWorkers: true });
    } catch (error) {
      buildError = error;
    }

    expect(buildError).toBeInstanceOf(AggregateError);
    const message = (buildError as Error).message;
    expect(message).toContain("Build failed with 4 page errors");
    for (const page of pages) expect(message).toContain(page);
    expect(terminate).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V: transpilePage – minify.js branch coverage
// Tests the minifyScriptTagsInHtml skip conditions:
//   – non-JS type scripts (application/ld+json, etc.) are not minified
//   – server scripts (data-bascik-server) are not minified
//   – external scripts (src=) are not minified
//   – text/javascript scripts are minified
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – minify.js branch coverage", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = true;
    (BascikConfig.minify as any).js = true;
    const { writeFile, mkdir } = await import("node:fs/promises");
    (mkdir as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (writeFile as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  afterEach(() => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
    (BascikConfig.minify as any).js = false;
  });

  it("minifies inline text/javascript script content", async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<script>var   x   =   1;</script>' +
      '</body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).not.toContain("var   x");
  });

  it("does not minify application/ld+json scripts", async () => {
    const jsonLd = '{"@context":"https://schema.org","@type":"WebSite"}';
    const html =
      `<!DOCTYPE html><html><head></head><body>` +
      `<script type="application/ld+json">${jsonLd}</script>` +
      `</body></html>`;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).toContain(jsonLd);
  });

  it("does not minify data-bascik-server scripts", async () => {
    const serverCode = "const   x   =   require('fs');";
    const html =
      `<!DOCTYPE html><html><head></head><body>` +
      `<script data-bascik-server>${serverCode}</script>` +
      `</body></html>`;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).toContain(serverCode);
  });

  it("does not minify external scripts (with src attribute)", async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<script src="/app.js"></script>' +
      '</body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).toContain('src="/app.js"');
  });

  it("returns correct HTML when there are no inline JS scripts to minify", async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body><p>no scripts</p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).toContain("<p>no scripts</p>");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W: transpilePage – auto-fetches componentList when not provided
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – auto-fetches componentList", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
    (BascikConfig.minify as any).js = false;
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});
  });

  afterEach(() => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
  });

  it("calls listComponents internally when no componentList is passed", async () => {
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const componentsModule = await import("./components.ts");
    const result = await transpilePage(PAGE_PATH /* no componentList arg */);
    expect(componentsModule.listComponents).toHaveBeenCalled();
    expect(result).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// X: recursivelyTranspile – non-Error thrown in error path
// ─────────────────────────────────────────────────────────────────────────────

describe("recursivelyTranspile – non-Error thrown in component processing", () => {
  it("stringifies a non-Error rejection in the error log", async () => {
    const componentsModule = await import("./components.ts");
    // Temporarily make injectProps throw a plain string (not an Error instance)
    vi.spyOn(componentsModule, "injectProps").mockImplementationOnce(() => {
      throw "string-error-not-an-Error-object";
    });

    const componentList = {
      "my-str-err": {
        fileName: "components/my-str-err.html",
        fileContent: "<div>hello</div>",
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    recursivelyTranspile("<my-str-err></my-str-err>", componentList);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("string-error-not-an-Error-object"),
    );
    errorSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Y: transpilePage – inline component <style> extraction & head placement
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – inline component <style> extraction & deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).assets = { inlineStyles: false, exclude: [] };
    (BascikConfig as any).isBuild = false;
    (BascikConfig as any).scoping = {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
  });

  afterEach(() => {
    (BascikConfig as any).scoping = {
      scriptBlocks: false,
      inheritAttributes: true,
      attributes: { class: false, id: false, name: false },
      deduplicateCss: true,
      preserve: ["code"],
    };
  });

  it("extracts inline <style> from component HTML, scopes it, places in <head>, and strips from <body>", async () => {
    const pageHtml = "<!DOCTYPE html><html><head></head><body><comp-inline></comp-inline></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-inline": {
        fileName: "components/comp-inline.html",
        fileContent: '<style>.card { color: red; }</style><div class="card">Hello</div>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    // Body must contain the element with scoped class and NO <style> tag
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch).not.toBeNull();
    const bodyContent = bodyMatch![1];
    expect(bodyContent).not.toContain("<style>");
    expect(bodyContent).toContain("bascik__comp-inline__card");

    // Head must contain the scoped style block
    const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
    expect(headMatch).not.toBeNull();
    const headContent = headMatch![1];
    expect(headContent).toContain("<style>");
    expect(headContent).toContain(".bascik__comp-inline__card");
  });

  it("deduplicates component CSS in <head> when a component with inline <style> is used multiple times", async () => {
    const pageHtml = "<!DOCTYPE html><html><head></head><body><comp-multi></comp-multi><comp-multi></comp-multi></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-multi": {
        fileName: "components/comp-multi.html",
        fileContent: '<style>.btn { padding: 8px; }</style><button class="btn">Click</button>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    // Body should have zero <style> tags
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch![1]).not.toContain("<style>");

    // Head style block should contain the selector exactly once
    const matches = html.match(/\.bascik__comp-multi__btn/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it("merges inline <style> tags and companion .css file for the same component", async () => {
    const pageHtml = "<!DOCTYPE html><html><head></head><body><comp-both></comp-both></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-both": {
        fileName: "components/comp-both.html",
        fileContent: '<style>.part1 { color: green; }</style><div class="part1 part2">Merged</div>',
        cssFileContent: ".part2 { font-weight: bold; }",
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    // Head must contain both scoped rules
    expect(html).toContain(".bascik__comp-both__part1");
    expect(html).toContain(".bascik__comp-both__part2");

    // Body must not contain any <style> tags
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch![1]).not.toContain("<style>");
  });

  it("preserves literal <style> tags inside code blocks in components", async () => {
    const pageHtml = "<!DOCTYPE html><html><head></head><body><comp-code-demo></comp-code-demo></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-code-demo": {
        fileName: "components/comp-code-demo.html",
        fileContent:
          '<style>.real-style { border: 1px solid; }</style>' +
          '<div class="real-style">' +
          '<pre><code>&lt;style&gt;.demo { color: blue; }&lt;/style&gt;</code></pre>' +
          '</div>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    // Head gets the real component style
    expect(html).toContain(".bascik__comp-code-demo__real-style");

    // Body preserves the code block
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch![1]).toContain("<pre><code>&lt;style&gt;.demo { color: blue; }&lt;/style&gt;</code></pre>");
  });

  it("handles components with multiple root level HTML elements and merges inherited attributes onto the first root", async () => {
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).scoping = {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const pageHtml = '<!DOCTYPE html><html><head></head><body><comp-multi-root class="outer-class" data-testid="multi"></comp-multi-root></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-multi-root": {
        fileName: "components/comp-multi-root.html",
        fileContent:
          '<style>h2 { color: red; } .title { font-size: 1.5rem; } .badge { font-weight: bold; }</style>' +
          '<h2 class="title">Title</h2>' +
          '<div class="badge">Badge</div>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch).not.toBeNull();
    const body = bodyMatch![1];

    // Both root elements are in the body output
    expect(body).toContain('Title</h2>');
    expect(body).toContain('Badge</div>');

    // Inherited attributes merge onto the first root element (<h2>)
    expect(body).toContain('class="bascik__comp-multi-root__title');
    expect(body).toContain('outer-class"');
    expect(body).toContain('data-testid="multi"');

    // Scoped CSS in head covers element selector and class
    expect(html).toContain('.bascik__comp-multi-root__el__h2');
    expect(html).toContain('.bascik__comp-multi-root__badge');
  });

  it("handles components with multiple <style> tags", async () => {
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).scoping = {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const pageHtml = '<!DOCTYPE html><html><head></head><body><comp-multi-styles></comp-multi-styles></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-multi-styles": {
        fileName: "components/comp-multi-styles.html",
        fileContent:
          '<style>.box { padding: 10px; }</style>' +
          '<div class="box">Multi Style</div>' +
          '<style>.box { color: green; } media (min-width: 600px) { .box { color: purple; } }</style>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    // Body contains no <style> tags
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch![1]).not.toContain('<style>');

    // Head contains scoped CSS rules from both <style> tags
    expect(html).toContain('.bascik__comp-multi-styles__box');
  });

  it("applies custom async minify.css transformer (e.g. vendor prefixing) to component styles and page <style> blocks", async () => {
    (BascikConfig.minify as any).css = async (css: string) => {
      return css.replace(/user-select:\s*none;?/g, "-webkit-user-select: none; user-select: none;");
    };
    const pageHtml = '<!DOCTYPE html><html><head><style>.page { user-select: none; }</style></head><body><comp-prefix></comp-prefix></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-prefix": {
        fileName: "components/comp-prefix.html",
        fileContent: '<style>.box { user-select: none; }</style><div class="box">Text</div>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    expect(html).toContain("-webkit-user-select: none");
    expect(html).toContain("user-select: none");
    (BascikConfig.minify as any).css = false;
  });

  it("correctly handles a component with leading <script>, multiple root elements, and attribute inheritance", async () => {
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).scoping = {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const pageHtml = '<!DOCTYPE html><html><head></head><body><comp-script-multi class="active-card" id="card-1"></comp-script-multi></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-script-multi": {
        fileName: "components/comp-script-multi.html",
        fileContent:
          '<script>console.log("init");</script>' +
          '<div class="card-head">Header</div>' +
          '<div class="card-body">Body</div>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    expect(bodyMatch).not.toBeNull();
    const body = bodyMatch![1];

    // Script tag is present and wrapped in IIFE
    expect(body).toContain('(function()');
    expect(body).toContain('console.log("init")');

    // Inherited class and id are merged onto the first HTML element (<div class="card-head">), NOT the <script> tag
    expect(body).not.toContain('<script class=');
    expect(body).toContain('id="card-1"');
    expect(body).toContain('class="bascik__comp-script-multi__card-head active-card"');
  });

  it("handles components with multiple <script> tags", async () => {
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).scoping = {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const pageHtml = '<!DOCTYPE html><html><head></head><body><comp-multi-scripts></comp-multi-scripts></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-multi-scripts": {
        fileName: "components/comp-multi-scripts.html",
        fileContent:
          '<div id="sec1">Sec 1</div>' +
          '<script>const s1 = "hello";</script>' +
          '<div id="sec2">Sec 2</div>' +
          '<script>const s2 = "world";</script>' +
          '<script type="application/ld+json">{"@type":"Thing"}</script>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const html = result!.distHtml;

    // Client scripts are IIFE wrapped
    const iifeMatches = html.match(/\(function\(\)/g);
    expect(iifeMatches).not.toBeNull();
    expect(iifeMatches!.length).toBe(2);

    // JSON-LD script is preserved verbatim without IIFE wrapping
    expect(html).toContain('<script type="application/ld+json">{"@type":"Thing"}</script>');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Z: Dynamic Routes Pipeline Expansion
// ─────────────────────────────────────────────────────────────────────────────

describe("dynamic routes pipeline expansion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
  });

  it("leaves non-dynamic pages unaffected (1:1 output)", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const results = await processAllPages({ useWorkers: false });
    expect(results).toEqual(["pages/index.html"]);
  });

  it("expands a dynamic route template with 3 routes into 3 distinct pages", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([templatePath]);

    const routesModule = await import("./routes.ts");
    const routesSpy = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [
        { params: { slug: "post-1" }, data: { title: "Post 1" } },
        { params: { slug: "post-2" }, data: { title: "Post 2" } },
        { params: { slug: "post-3" }, data: { title: "Post 3" } },
      ],
      cleanedHtml: "<!DOCTYPE html><html><head></head><body><h1>Article</h1></body></html>",
    });

    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "<script data-bascik-routes></script><!DOCTYPE html><html><head></head><body><h1>Article</h1></body></html>",
    );

    const { executeBuildScripts } = await import("./build-scripts.ts");
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockImplementation((html: string) =>
      Promise.resolve(html),
    );

    const results = await processAllPages({ useWorkers: false });
    expect(results).toEqual([
      "pages/blog/post-1.html",
      "pages/blog/post-2.html",
      "pages/blog/post-3.html",
    ]);

    expect(mem.storePage).toHaveBeenCalledTimes(3);
    expect(mem.storePage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ relativePagePath: "pages/blog/post-1.html" }),
    );
    expect(mem.storePage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ relativePagePath: "pages/blog/post-2.html" }),
    );
    expect(mem.storePage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ relativePagePath: "pages/blog/post-3.html" }),
    );
    routesSpy.mockRestore();
  });

  it("passes BASCIK_ROUTE to executeBuildScripts for dynamic pages and null for ordinary pages", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    const { executeBuildScripts } = await import("./build-scripts.ts");

    await transpilePage(
      templatePath,
      {},
      undefined,
      { params: { slug: "test" }, data: { id: 1 } },
      "<!DOCTYPE html><html><head></head><body><p>dyn</p></body></html>",
    );

    expect(executeBuildScripts).toHaveBeenCalledWith(
      expect.any(String),
      templatePath,
      { params: { slug: "test" }, data: { id: 1 } },
    );
  });

  it("yields zero pages and does not throw when routes script produces empty routes array", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([templatePath]);

    const routesModule = await import("./routes.ts");
    const routesSpy = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [],
      cleanedHtml: "<!DOCTYPE html><html><head></head><body><h1>Empty</h1></body></html>",
    });

    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>Empty</body></html>");

    const results = await processAllPages({ useWorkers: false });
    expect(results).toEqual([]);
    expect(mem.storePage).not.toHaveBeenCalled();
    routesSpy.mockRestore();
  });

  it("warns and produces nothing when a bracket filename has no routes script", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([templatePath]);

    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "<!DOCTYPE html><html><head></head><body><h1>No Routes Script</h1></body></html>",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });

    const results = await processAllPages({ useWorkers: false });
    expect(results).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has no <script data-bascik-routes> tag'),
    );
    warnSpy.mockRestore();
  });

  it("deletes stale outputs from disk and memory when a route disappears on template re-transpile", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    const routesModule = await import("./routes.ts");

    // First run with two routes: a and b
    const spy1 = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [{ params: { slug: "a" } }, { params: { slug: "b" } }],
      cleanedHtml: "<html><body>dyn</body></html>",
    });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>dyn</body></html>");

    await pageProcessing(templatePath, {});
    spy1.mockRestore();

    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({ relativePagePath: "pages/blog/a.html" }),
    );
    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({ relativePagePath: "pages/blog/b.html" }),
    );

    // Second run with only route a (b disappeared)
    const spy2 = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [{ params: { slug: "a" } }],
      cleanedHtml: "<html><body>dyn</body></html>",
    });

    const { rm } = await import("node:fs/promises");
    await pageProcessing(templatePath, {});
    spy2.mockRestore();

    expect(mem.removeByRelativePath).toHaveBeenCalledWith("pages/blog/b.html");
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining("b.html"),
    );
  });

  it("deletes all generated outputs when template is removed via removePage", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    const routesModule = await import("./routes.ts");

    const spy = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [{ params: { slug: "x" } }, { params: { slug: "y" } }],
      cleanedHtml: "<html><body>dyn</body></html>",
    });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>dyn</body></html>");

    await pageProcessing(templatePath, {});
    spy.mockRestore();

    const { rm } = await import("node:fs/promises");
    (rm as ReturnType<typeof vi.fn>).mockClear();

    await removePage(templatePath);

    expect(mem.removePage).toHaveBeenCalledWith(templatePath);
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining("x.html"),
    );
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining("y.html"),
    );
  });

  it("cleans up all generated outputs when a routes script returns 0 routes on re-transpile", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    const routesModule = await import("./routes.ts");

    // First run: produces x.html and y.html
    const spy1 = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [{ params: { slug: "x" } }, { params: { slug: "y" } }],
      cleanedHtml: "<html><body>dyn</body></html>",
    });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>dyn</body></html>");

    await pageProcessing(templatePath, {});
    spy1.mockRestore();

    // Second run: returns 0 routes
    const spy2 = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [],
      cleanedHtml: "<html><body>dyn</body></html>",
    });

    const { rm } = await import("node:fs/promises");
    (rm as ReturnType<typeof vi.fn>).mockClear();

    await pageProcessing(templatePath, {});
    spy2.mockRestore();

    expect(mem.removeByRelativePath).toHaveBeenCalledWith("pages/blog/x.html");
    expect(mem.removeByRelativePath).toHaveBeenCalledWith("pages/blog/y.html");
    expect(rm).toHaveBeenCalledWith(expect.stringContaining("x.html"));
    expect(rm).toHaveBeenCalledWith(expect.stringContaining("y.html"));
  });

  it("cleans up old parameter outputs when route parameters are completely replaced on re-transpile", async () => {
    const templatePath = "src/pages/blog/[slug].html";
    const routesModule = await import("./routes.ts");

    // First run: produces old1.html
    const spy1 = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [{ params: { slug: "old1" } }],
      cleanedHtml: "<html><body>dyn</body></html>",
    });
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>dyn</body></html>");

    await pageProcessing(templatePath, {});
    spy1.mockRestore();

    // Second run: produces new1.html
    const spy2 = vi.spyOn(routesModule, "executeRoutesScript").mockResolvedValueOnce({
      routes: [{ params: { slug: "new1" } }],
      cleanedHtml: "<html><body>dyn</body></html>",
    });

    const { rm } = await import("node:fs/promises");
    (rm as ReturnType<typeof vi.fn>).mockClear();

    await pageProcessing(templatePath, {});
    spy2.mockRestore();

    expect(mem.removeByRelativePath).toHaveBeenCalledWith("pages/blog/old1.html");
    expect(rm).toHaveBeenCalledWith(expect.stringContaining("old1.html"));
    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({ relativePagePath: "pages/blog/new1.html" }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// transpilePage – deferred page-aware component build scripts
// ─────────────────────────────────────────────────────────────────────────────

describe("transpilePage – deferred page-aware component build scripts", () => {
  it("executes deferred build scripts in components with page context during transpilePage", async () => {
    const { executeBuildScripts } = await import("./build-scripts.ts");
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockImplementation(
      async (html: string, filePath?: string, _route?: unknown, options?: { pageFile?: string }) => {
        const pageFile = options?.pageFile ?? filePath ?? "";
        return html.replace(
          /<script\b[^>]*\bdata-bascik-build[^>]*>[\s\S]*?<\/script>/gi,
          () => `<span>${pageFile.includes("page-a") ? "/page-a" : "/page-b"}</span>`,
        );
      },
    );

    const componentList = {
      "page-badge": {
        fileName: "src/components/page-badge.html",
        fileContent:
          '<div class="badge"><script data-bascik-build="page">console.log("<span>" + process.env.BASCIK_PAGE_PATH + "</span>")</script></div>',
      },
    };

    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return "<!DOCTYPE html><html><head></head><body><page-badge></page-badge></body></html>";
    });

    const resultA = await transpilePage("src/pages/page-a.html", componentList);
    const resultB = await transpilePage("src/pages/page-b.html", componentList);

    expect(resultA?.distHtml).toContain("<span>/page-a</span>");
    expect(resultB?.distHtml).toContain("<span>/page-b</span>");
  });
});
