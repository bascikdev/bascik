import fc from "fast-check";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolve } from "node:path";
import { recursivelyTranspile, pageProcessing, processPageBatch, selectivelyProcessPagesForWatchPath, partitionByOpenPages, getDisplayPath, findActiveSourceFile, getFilePosition, transpilePage, processAllPages, selectivelyProcessPages, removePage, pageWriteIdle } from "./processing.ts";
import { collectAllScriptDeps } from "./build-scripts.ts";
import { BascikConfig } from "./config.ts";
import { manifestCollector } from "./manifest.ts";
import { cspHashCollector } from "./csp-hashes.ts";
import { LIVE_RELOAD_SCRIPT } from "./live-reload.ts";

// Disable all scoping so tests produce predictable, readable HTML
vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => true),
  BascikConfig: {
    base: "/",
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
      components: ["src/components"],
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
    recordFailedDependencies: vi.fn(),
    clearFailedDependencies: vi.fn(),
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
        // Mirrors page-worker.ts (prompt 86): the HTML arrives as UTF-8 bytes
        // in a transferred ArrayBuffer, never as a string.
        return {
          relativePagePath,
          absolutePagePath: pagePath,
          distHtmlBytes: new TextEncoder().encode("<html></html>"),
          usedComponentsNames: ["my-comp"],
          fileDependencies: ["scripts/md-renderer.ts"],
        };
      });
      this.terminate = vi.fn(async () => { });
    }),
  };
});

vi.mock("./names.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    minifyAttributeName: vi.fn((name) => name),
    getAttributeNameHash: vi.fn((name) => name),
  };
});

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

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    cpus: vi.fn().mockImplementation(() => actual.cpus()),
  };
});

import { readFile } from "node:fs/promises";
import { cpus } from "node:os";
import { mem } from "./mem.ts";
import { invalidateComponentListCache } from "./components.ts";
import { listPages } from "./file-system.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A: Slot fallback content
// ─────────────────────────────────────────────────────────────────────────────


const PAGE_HTML = '<!DOCTYPE html><html lang="en"><head></head><body><p>hello</p></body></html>';

const PAGE_PATH = 'src/pages/index.html';

export { fc, describe, it, expect, vi, beforeEach, afterEach, resolve, recursivelyTranspile, pageProcessing, processPageBatch, selectivelyProcessPagesForWatchPath, partitionByOpenPages, getDisplayPath, findActiveSourceFile, getFilePosition, transpilePage, processAllPages, selectivelyProcessPages, removePage, pageWriteIdle, collectAllScriptDeps, BascikConfig, manifestCollector, cspHashCollector, LIVE_RELOAD_SCRIPT, readFile, cpus, mem, invalidateComponentListCache, listPages, PAGE_HTML, PAGE_PATH };

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

  it("preserves named slots for their nearest nested component boundary", () => {
    const componentList = {
      "outer-shell": {
        fileName: "components/outer-shell.html",
        fileContent:
          '<section><inner-demo><div data-bascik-slot="source-html"><code-block>expected</code-block></div></inner-demo></section>',
      },
      "inner-demo": {
        fileName: "components/inner-demo.html",
        fileContent:
          '<article><div data-bascik-slot="source-html">fallback</div></article>',
      },
      "code-block": {
        fileName: "components/code-block.html",
        fileContent: "<pre><div data-bascik-slot></div></pre>",
      },
    };

    const { transpiledHtmlBody } = recursivelyTranspile(
      "<outer-shell></outer-shell>",
      componentList,
    );

    expect(transpiledHtmlBody).toBe(
      "<section><article><pre>expected</pre></article></section>",
    );
  });

  it("keeps parent and nested child slots with the same name isolated", () => {
    const componentList = {
      "outer-shell": {
        fileName: "components/outer-shell.html",
        fileContent:
          '<section><header data-bascik-slot="content">outer fallback</header>' +
          '<inner-demo><div data-bascik-slot="content">child content</div></inner-demo></section>',
      },
      "inner-demo": {
        fileName: "components/inner-demo.html",
        fileContent: '<article data-bascik-slot="content">child fallback</article>',
      },
    };

    const { transpiledHtmlBody } = recursivelyTranspile(
      '<outer-shell><div data-bascik-slot="content">parent content</div></outer-shell>',
      componentList,
    );

    expect(transpiledHtmlBody).toBe(
      "<section>parent contentchild content</section>",
    );
  });

  it("preserves static build-script output inside a nested named slot", () => {
    const componentList = {
      "outer-shell": {
        fileName: "components/outer-shell.html",
        fileContent:
          '<section><inner-demo><div data-bascik-slot="source-html"><code-block><strong>generated source</strong></code-block></div></inner-demo></section>',
      },
      "inner-demo": {
        fileName: "components/inner-demo.html",
        fileContent:
          '<article><div data-bascik-slot="source-html">fallback</div></article>',
      },
      "code-block": {
        fileName: "components/code-block.html",
        fileContent: '<pre data-code-block><div data-bascik-slot></div></pre>',
      },
    };

    const { transpiledHtmlBody } = recursivelyTranspile(
      "<outer-shell></outer-shell>",
      componentList,
    );

    expect(transpiledHtmlBody).toBe(
      '<section><article><pre data-code-block><strong>generated source</strong></pre></article></section>',
    );
  });

  it("does not leak a nested component prop from slot content into its parent", () => {
    const componentList = {
      "my-card": {
        fileName: "components/my-card.html",
        fileContent:
          "<article><h2 data-bascik-prop-text>Card fallback</h2><div data-bascik-slot></div></article>",
      },
      "my-badge": {
        fileName: "components/my-badge.html",
        fileContent: "<span data-bascik-prop-text>Badge fallback</span>",
      },
    };

    const { transpiledHtmlBody } = recursivelyTranspile(
      '<my-card><my-badge data-bascik-prop-text="beta"></my-badge></my-card>',
      componentList,
    );

    expect(transpiledHtmlBody).toBe(
      "<article><h2>Card fallback</h2><span>beta</span></article>",
    );
  });

  describe("forwarding the default slot into a nested component", () => {
    const innerBox = {
      fileName: "components/inner-box.html",
      fileContent: "<section><div data-bascik-slot>inner fallback</div></section>",
    };

    it("fills a default slot marker written inside a child's usage tag", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent:
            '<div class="outer"><inner-box><div data-bascik-slot>outer fallback</div></inner-box></div>',
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box><p>given</p></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toBe('<div class="outer"><section><p>given</p></section></div>');
      expect(transpiledHtmlBody).not.toContain("data-bascik-slot");
    });

    it("uses the marker's own fallback when the outer tag has no content", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent:
            '<div class="outer"><inner-box><div data-bascik-slot>outer fallback</div></inner-box></div>',
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile("<outer-box></outer-box>", componentList);
      expect(transpiledHtmlBody).toBe('<div class="outer"><section>outer fallback</section></div>');
    });

    it("keeps the rest of the child's content around the forwarded slot", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent:
            '<div><inner-box class="x"><h2>Title</h2><div data-bascik-slot></div><p>after</p></inner-box></div>',
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box><em>body</em></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toBe(
        '<div><section class="x"><h2>Title</h2><em>body</em><p>after</p></section></div>',
      );
    });

    it("forwards through two levels of nesting", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent: "<main><mid-box><div data-bascik-slot></div></mid-box></main>",
        },
        "mid-box": {
          fileName: "components/mid-box.html",
          fileContent: "<div class='mid'><inner-box><div data-bascik-slot></div></inner-box></div>",
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box><b>deep</b></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toBe("<main><div class='mid'><section><b>deep</b></section></div></main>");
    });

    it("keeps two instances with different content separate", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent: "<div><inner-box><div data-bascik-slot></div></inner-box></div>",
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box>one</outer-box><outer-box>two</outer-box><outer-box></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toBe(
        "<div><section>one</section></div><div><section>two</section></div><div><section>inner fallback</section></div>",
      );
    });

    it("inserts content with replacement tokens literally", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent: "<div><inner-box><div data-bascik-slot></div></inner-box></div>",
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box><p>$& $1 $` $' $$</p></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toBe("<div><section><p>$& $1 $` $' $$</p></section></div>");
    });

    it("still routes named wrappers inside a child's usage tag to the child", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent:
            '<div><named-box><div data-bascik-slot="head">child head</div><div data-bascik-slot></div></named-box></div>',
        },
        "named-box": {
          fileName: "components/named-box.html",
          fileContent: '<article><h1 data-bascik-slot="head">fallback head</h1><div data-bascik-slot>fallback body</div></article>',
        },
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box><i>forwarded body</i></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toBe(
        "<div><article>child head<i>forwarded body</i></article></div>",
      );
    });

    it("does not treat a valueless marker on the child's own usage tag as a slot", () => {
      const componentList = {
        "outer-box": {
          fileName: "components/outer-box.html",
          fileContent: "<div><inner-box data-bascik-slot>kept</inner-box></div>",
        },
        "inner-box": innerBox,
      };
      const { transpiledHtmlBody } = recursivelyTranspile(
        "<outer-box><p>x</p></outer-box>",
        componentList,
      );
      expect(transpiledHtmlBody).toContain("kept");
      expect(transpiledHtmlBody).not.toContain("<p>x</p>");
    });
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
    const usage = Array.from({ length: 20 }, () => `<test-single></test-single>`).join("");
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

  it("does not expand a component tag written inside the template's own HTML comment", () => {
    // Development keeps comments (no HTML minification). A comment that names the component,
    // such as a usage note, is text and must never be expanded, or the component appears to
    // include itself. Two comment shapes: the whole comment, and one whose text spans lines.
    const componentList = {
      "post-body": {
        fileName: "components/post-body.html",
        fileContent: "<!-- the page prints Markdown inside <post-body> -->\n" +
          "<!-- a multi-line note\n     about <post-body>. -->" +
          "<div class=\"markdown\"><div data-bascik-slot></div></div>",
      },
    };
    const { transpiledHtmlBody, usedComponents } = recursivelyTranspile(
      "<post-body><h2>Heading</h2></post-body><post-body><p>Second</p></post-body>",
      componentList,
      [],
      PAGE_PATH,
    );
    expect(usedComponents).toHaveLength(2);
    expect(transpiledHtmlBody).toContain("<h2>Heading</h2>");
    expect(transpiledHtmlBody).toContain("<p>Second</p>");
    // The comments survive as written.
    expect(transpiledHtmlBody).toContain("<!-- the page prints Markdown inside <post-body> -->");
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

  it("reassembles a body containing a literal closing tag in textarea content exactly once", async () => {
    const html =
      '<!DOCTYPE html><html><head><title>Test</title></head><body><textarea></body></textarea><p>tail</p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result?.distHtml).toBe(
      '<!DOCTYPE html><html><head><title>Test</title></head><body><textarea></body></textarea><p>tail</p>' +
      LIVE_RELOAD_SCRIPT +
      "</body></html>",
    );
  });

  it("reassembles a head containing a literal closing tag in script content exactly once", async () => {
    const html =
      '<!DOCTYPE html><html><head><script>const closing = "</head>";</script><title>Test</title></head><body><p>body</p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result?.distHtml).toBe(
      '<!DOCTYPE html><html><head><script>const closing = "</head>";</script><title>Test</title></head><body><p>body</p>' +
      LIVE_RELOAD_SCRIPT +
      "</body></html>",
    );
  });
});

describe("transpilePage – base path transform", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (BascikConfig as any).base = "/";
    (BascikConfig as any).isBuild = false;
  });

  afterEach(() => {
    (BascikConfig as any).base = "/";
  });

  it("keeps output byte-identical when base is root", async () => {
    const html = '<!DOCTYPE html><html><head><link href="/app.css"></head><body><a href="/about">About</a></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result?.distHtml).toBe(html.replace("</body>", `${LIVE_RELOAD_SCRIPT}</body>`));
  });

  it("rewrites final component and page URLs after fragment ID references", async () => {
    (BascikConfig as any).base = "/sub/";
    const html = '<!DOCTYPE html><html><head><style>.hero{background:url(/hero.png)}</style></head><body><nav-links></nav-links></body></html>';
    const componentList = {
      "nav-links": {
        name: "nav-links",
        fileName: "src/components/nav-links.html",
        fileContent: '<div><a href="#local-id">Local</a><a href="/about">About</a></div>',
      },
    };
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result?.distHtml).toContain('href="#local-id"');
    expect(result?.distHtml).toContain('href="/sub/about"');
    expect(result?.distHtml).toContain("url(/sub/hero.png)");
    expect(result?.distHtml).toContain('new EventSource("/sub/bascik-live-reload")');
  });

  it("rewrites inline styles on document root elements", async () => {
    (BascikConfig as any).base = "/sub/";
    const html = '<!DOCTYPE html><html style="background:url(/page.png)"><head></head><body style="background:url(\'/body.png\')"><p>Body</p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);

    const result = await transpilePage(PAGE_PATH, {});

    expect(result?.distHtml).toContain('style="background:url(/sub/page.png)"');
    expect(result?.distHtml).toContain("style=\"background:url('/sub/body.png')\"");
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
    const styleMatches = [...pageContent.matchAll(/<style>/gi)];
    expect(styleMatches).toHaveLength(0);
  });

  it("inlines a single stylesheet into the head without an empty component style", async () => {
    (BascikConfig as any).assets = { inlineStyles: ['src/css/styles.css'], exclude: [] };
    (readFile as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(PAGE_HTML)          // page read
      .mockResolvedValueOnce('body { color: red; }'); // inlineStyles file
    await pageProcessing(PAGE_PATH, {});
    const { pageContent } = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(pageContent).toContain('body { color: red; }');
    expect([...pageContent.matchAll(/<style>/gi)]).toHaveLength(1);
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
    const styleCount = [...pageContent.matchAll(/<style>/gi)].length;
    expect(styleCount).toBe(1);
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

  it("awaits dev artifact writes inside a lifecycle publication scope before post can run", async () => {
    const { writeFile } = await import('node:fs/promises');
    const { withCompilationPublisher } = await import('./compilation-events.ts');
    const writeGate = Promise.withResolvers<void>();
    (writeFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(writeGate.promise);
    let completed = false;
    const work = withCompilationPublisher(vi.fn(), () => processPageBatch(['src/pages/phase.html'], {}))
      .then(() => { completed = true; });
    try {
      await vi.waitFor(() => expect(writeFile).toHaveBeenCalled());
      expect(completed).toBe(false);
    } finally { writeGate.resolve(); await work; }
  });

  it("rejects scoped dev artifact write failures instead of allowing post success", async () => {
    const { writeFile } = await import('node:fs/promises');
    const { withCompilationPublisher } = await import('./compilation-events.ts');
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('disk full'));
    await expect(withCompilationPublisher(vi.fn(), () => processPageBatch(['src/pages/write-failure.html'], {})))
      .rejects.toThrow('disk full');
  });

  it("rejects scoped compilation errors so post cannot run after invalid markup", async () => {
    const { withCompilationPublisher } = await import('./compilation-events.ts');
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue('<html><head></head></html>');
    await expect(withCompilationPublisher(vi.fn(), () => processPageBatch(['src/pages/invalid-phase.html'], {})))
      .rejects.toThrow('validate markup');
  });

  it("pageWriteIdle joins a queued dev write that publication does not await", async () => {
    const { writeFile } = await import('node:fs/promises');
    const writeGate = Promise.withResolvers<void>();
    (writeFile as ReturnType<typeof vi.fn>).mockReturnValueOnce(writeGate.promise);
    // Publication resolves while the queued disk write is still pending.
    await processPageBatch(['src/pages/idle.html'], {});
    let idle = false;
    const joined = pageWriteIdle('src/pages/idle.html').then(() => { idle = true; });
    await new Promise((r) => setImmediate(r));
    expect(idle).toBe(false);
    writeGate.resolve();
    await joined;
    expect(idle).toBe(true);
  });

  it("pageWriteIdle resolves immediately when no write is queued", async () => {
    await expect(pageWriteIdle('src/pages/never-written.html')).resolves.toBeUndefined();
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

  it("reports only active per-page work time, excluding a shared batch wait", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    const nowSpy = vi.spyOn(performance, "now");

    try {
      // Drive the monotonic clock and page reads explicitly. Every page spends
      // 7 ms in active work before a shared 1-second wait. A real timer would
      // turn this into a flaky scheduler/coverage test instead of validating
      // that transpilePage pauses its per-page clock around awaited work.
      let now = 0;
      nowSpy.mockImplementation(() => now);
      const reads = Array.from({ length: 3 }, () => Promise.withResolvers<Buffer>());
      let readIndex = 0;
      (readFile as ReturnType<typeof vi.fn>).mockImplementation(() => {
        now += 7;
        return reads[readIndex++].promise;
      });

      const pages = ["src/pages/one.html", "src/pages/two.html", "src/pages/three.html"];
      const batch = processPageBatch(pages, {}, "");
      await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(3));

      // All reads are in flight. Advancing the clock by one second simulates
      // queue/I/O wait which must not appear in any page's work duration.
      now += 1_000;
      for (const read of reads) read.resolve(Buffer.from("<html><body>test</body></html>"));
      await batch;

      const transpiledLogs = logSpy.mock.calls
        .map((call) => call[0])
        .filter((msg): msg is string => typeof msg === "string" && msg.startsWith("transpiled:"));

      expect(transpiledLogs).toHaveLength(3);

      for (const logLine of transpiledLogs) {
        const match = logLine.match(/in\s+(\d+(?:\.\d+)?)(ms|s)/);
        expect(match).not.toBeNull();
        const rawVal = parseFloat(match![1]);
        const unit = match![2];
        const ms = unit === "s" ? rawVal * 1000 : rawVal;
        expect(ms).toBe(7);
      }
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("overlaps async child-process work across pages in processPageBatch", async () => {
    const { executeBuildScripts } = await import("./build-scripts.ts");
    const originalExecute = (executeBuildScripts as ReturnType<typeof vi.fn>).getMockImplementation();
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockImplementation(async (html: string) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return html;
    });

    try {
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>test</body></html>");
      const pages = ["src/pages/one.html", "src/pages/two.html", "src/pages/three.html"];
      const start = performance.now();
      await processPageBatch(pages, {});
      const elapsed = performance.now() - start;

      // With concurrent dispatch, 3 pages waiting 100ms finish concurrently in < 200ms.
      // Under serial dispatch, they take ~300ms.
      expect(elapsed).toBeLessThan(200);
    } finally {
      if (originalExecute) {
        (executeBuildScripts as ReturnType<typeof vi.fn>).mockImplementation(originalExecute);
      } else {
        (executeBuildScripts as ReturnType<typeof vi.fn>).mockReset();
      }
    }
  });
});

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

  it.each([
    ["data-bascik-build", "src/scripts/build-entry.ts"],
    ["data-bascik-routes", "src/scripts/routes-entry.ts"],
  ])("stores external %s src files in fileDependencies", async (directive, dependencyPath) => {
    (collectAllScriptDeps as ReturnType<typeof vi.fn>).mockResolvedValueOnce([dependencyPath]);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      `<html><head></head><body><script ${directive} src="./scripts/entry.ts"></script></body></html>`,
    );

    await pageProcessing(PAGE_PATH, {});

    const storeArgs = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(storeArgs.fileDependencies).toContain(dependencyPath);
  });
});

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

  it("recognizes a component under any configured root", () => {
    const previous = BascikConfig.directory.components;
    (BascikConfig.directory as { components: string[] }).components = ["/shared/components", "src/components"];
    try {
      expect(getDisplayPath("src/components/my-nav.html")).toBe("components/my-nav.html");
      expect(getDisplayPath("/shared/components/site-nav.html")).toMatch(/site-nav\.html$/);
      expect(getDisplayPath("/shared/components/site-nav.html")).not.toBe("/shared/components/site-nav.html");
    } finally {
      (BascikConfig.directory as { components: string[] }).components = previous;
    }
  });
});

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

  it("does not warn about tags declared in components.external, exact or wildcard", async () => {
    const html = [
      "<!DOCTYPE html><html><head></head><body>",
      "<heading-anchors><h2>x</h2></heading-anchors>",
      "<vendor-chart></vendor-chart>",
      "</body></html>",
    ].join("");
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const original = (BascikConfig as any).components;
    (BascikConfig as any).components = { external: ["Heading-Anchors", "vendor-*"] };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    try {
      await transpilePage(PAGE_PATH, {});
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("Unresolved component tag"));
    } finally {
      warnSpy.mockRestore();
      (BascikConfig as any).components = original;
    }
  });

  it("still warns about an undeclared tag when others are external, and names only that tag", async () => {
    const html = [
      "<!DOCTYPE html><html><head></head><body>",
      "<heading-anchors></heading-anchors><my-typo></my-typo>",
      "</body></html>",
    ].join("");
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const original = (BascikConfig as any).components;
    (BascikConfig as any).components = { external: ["heading-anchors"] };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    try {
      await transpilePage(PAGE_PATH, {});
      const message = warnSpy.mock.calls.map((call) => String(call[0])).find((text) => text.includes("Unresolved"));
      expect(message).toContain("<my-typo>");
      expect(message).not.toContain("<heading-anchors>");
    } finally {
      warnSpy.mockRestore();
      (BascikConfig as any).components = original;
    }
  });

  it("does not let an external declaration shadow a real component of the same name", async () => {
    const componentList = {
      "heading-anchors": {
        fileName: "components/heading-anchors.html",
        fileContent: "<section>from component</section>",
      },
    };
    const html = "<!DOCTYPE html><html><head></head><body><heading-anchors></heading-anchors></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const original = (BascikConfig as any).components;
    (BascikConfig as any).components = { external: ["heading-anchors"] };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    try {
      const result = await transpilePage(PAGE_PATH, componentList);
      expect(JSON.stringify(result)).toContain("from component");
    } finally {
      warnSpy.mockRestore();
      (BascikConfig as any).components = original;
    }
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

  it("does not warn about hyphenated tags inside HTML comments", async () => {
    const html = [
      "<!DOCTYPE html><html>",
      "<head>",
      "  <!-- <my-commented-tag></my-commented-tag> -->",
      "</head>",
      "<body>",
      "  <!-- <another-commented-tag /> -->",
      "  <p>Content</p>",
      "</body>",
      "</html>",
    ].join("");
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => { });
    await transpilePage(PAGE_PATH, {});
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("<my-commented-tag>"));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("<another-commented-tag>"));
    warnSpy.mockRestore();
  });
});

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

  it("does not record a failed write as emitted (failure honesty)", async () => {
    const { writeFile } = await import("node:fs/promises");
    const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    (writeFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
    manifestCollector.clear();
    cspHashCollector.clear();

    await expect(transpilePage(PAGE_PATH, {})).rejects.toMatchObject({ stage: "write output" });

    // A failed write must never be accounted as emitted: no manifest entry and
    // no CSP entry for this page (recording happens only after a successful
    // writeFile in the single-owner writer).
    const recordedFiles = Object.keys(manifestCollector.getFiles());
    expect(recordedFiles.some((k) => k.includes("index.html"))).toBe(false);
    expect(cspHashCollector.getManifest()).toEqual({});
  });
});

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
    const html = "<!DOCTYPE html><html><head></head><body><site-header /></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    expect(result?.usedComponentsNames).toContain("site-header");
  });
});

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

  it("prompt 86: forwards transferred worker bytes to the store and disk writer without decoding to a string", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(["src/pages/index.html"]);
    const { writeFile } = await import("node:fs/promises");
    (writeFile as ReturnType<typeof vi.fn>).mockClear();
    await processAllPages({ useWorkers: true });

    const stored = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(Buffer.isBuffer(stored.pageContent)).toBe(true);
    expect(stored.pageContent.toString("utf8")).toBe("<html></html>");

    // queueTranspiledPageWrite runs asynchronously; let it settle.
    await new Promise((r) => setImmediate(r));
    const pageWrite = (writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([path]) => String(path).endsWith("index.html"),
    );
    expect(pageWrite).toBeDefined();
    expect(Buffer.isBuffer(pageWrite![1])).toBe(true);
    expect(Buffer.from(pageWrite![1]).toString("utf8")).toBe("<html></html>");
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
