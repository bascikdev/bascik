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

  it("emits diagnostic advisory at exact boundaries: elapsed=2000, jobs=20, cpus>=4", async () => {
    (cpus as ReturnType<typeof vi.fn>).mockReturnValue([
      {} as any, {} as any, {} as any, {} as any // 4 cores
    ]);
    const pages = Array.from({ length: 20 }, (_, i) => `src/pages/page-${i}.html`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, "now");
    let callCount = 0;
    nowSpy.mockImplementation(() => {
      callCount++;
      return callCount > 1 ? 2000 : 0;
    });

    try {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      await processAllPages({ useWorkers: false });

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      const diagnosticLine = logs.find((l) => l.includes("💡 Boot transpilation took"));

      expect(diagnosticLine).toBeDefined();
      expect(diagnosticLine).toContain("pipeline.workers: true");
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("suppresses the diagnostic advisory at boundary: cpus < 4", async () => {
    (cpus as ReturnType<typeof vi.fn>).mockReturnValue([
      {} as any, {} as any, {} as any // 3 cores (< 4)
    ]);
    const pages = Array.from({ length: 20 }, (_, i) => `src/pages/page-${i}.html`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, "now");
    let callCount = 0;
    nowSpy.mockImplementation(() => {
      callCount++;
      return callCount > 1 ? 2500 : 0;
    });

    try {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      await processAllPages({ useWorkers: false });

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      const diagnosticLine = logs.find((l) => l.includes("💡 Boot transpilation took"));
      expect(diagnosticLine).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("suppresses the diagnostic advisory when useWorkers is true", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => `src/pages/page-${i}.html`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, "now");
    let callCount = 0;
    nowSpy.mockImplementation(() => {
      callCount++;
      return callCount > 1 ? 2500 : 0;
    });

    try {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      await processAllPages({ useWorkers: true });

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      const diagnosticLine = logs.find((l) => l.includes("💡 Boot transpilation took"));
      expect(diagnosticLine).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("suppresses the diagnostic advisory in build mode", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => `src/pages/page-${i}.html`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, "now");
    let callCount = 0;
    nowSpy.mockImplementation(() => {
      callCount++;
      return callCount > 1 ? 2500 : 0;
    });

    try {
      (BascikConfig as Record<string, unknown>).isBuild = true;
      await processAllPages({ useWorkers: false });

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      const diagnosticLine = logs.find((l) => l.includes("💡 Boot transpilation took"));
      expect(diagnosticLine).toBeUndefined();
    } finally {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("suppresses the diagnostic advisory at boundary: elapsed=1999 (under 2000ms)", async () => {
    const pages = Array.from({ length: 20 }, (_, i) => `src/pages/page-${i}.html`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, "now");
    let callCount = 0;
    nowSpy.mockImplementation(() => {
      callCount++;
      return callCount > 1 ? 1999 : 0;
    });

    try {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      await processAllPages({ useWorkers: false });

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      const diagnosticLine = logs.find((l) => l.includes("💡 Boot transpilation took"));
      expect(diagnosticLine).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("suppresses the diagnostic advisory at boundary: jobs=19 (under 20)", async () => {
    const pages = Array.from({ length: 19 }, (_, i) => `src/pages/page-${i}.html`);
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const nowSpy = vi.spyOn(performance, "now");
    let callCount = 0;
    nowSpy.mockImplementation(() => {
      callCount++;
      return callCount > 1 ? 2500 : 0;
    });

    try {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      await processAllPages({ useWorkers: false });

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      const diagnosticLine = logs.find((l) => l.includes("💡 Boot transpilation took"));
      expect(diagnosticLine).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

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

  it("minifies inline module script content", async () => {
    const html =
      '<!DOCTYPE html><html><head></head><body>' +
      '<script type="module">const   value   =   1;</script>' +
      '</body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).not.toContain("const   value");
  });

  it("does not emit an empty component style block", async () => {
    const html = '<!DOCTYPE html><html><head></head><body><p>content</p></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).not.toMatch(/<style>\s*<\/style>/);
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

  it("replaces data-bascik-server scripts with inert sidecar placeholder and preserves source in sidecar", async () => {
    const serverCode = "const   x   =   require('fs');";
    const html =
      `<!DOCTYPE html><html><head></head><body>` +
      `<script data-bascik-server>${serverCode}</script>` +
      `</body></html>`;
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    const result = await transpilePage(PAGE_PATH, {});
    expect(result).not.toBeNull();
    expect(result!.distHtml).not.toContain(serverCode);
    expect(result!.distHtml).toContain('type="text/bascik-server"');
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

  it("preserves attributes inside a component subtree matching a preserve wildcard", async () => {
    (BascikConfig as any).isBuild = true;
    (BascikConfig as any).scoping = {
      scriptBlocks: true,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["vendor-*"],
    };
    const pageHtml = "<!DOCTYPE html><html><head></head><body><comp-vendor></comp-vendor></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(pageHtml);

    const componentList = {
      "comp-vendor": {
        fileName: "components/comp-vendor.html",
        fileContent:
          '<vendor-widget id="keep" name="keep" class="keep"><span id="inner" class="inner">x</span></vendor-widget>' +
          '<p id="outer" class="outer">y</p>',
      },
    };

    const result = await transpilePage(PAGE_PATH, componentList);
    expect(result).not.toBeNull();
    const body = result!.distHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)![1];

    // Vendor subtree stays literal
    expect(body).toContain('<vendor-widget id="keep" name="keep" class="keep">');
    expect(body).toContain('<span id="inner" class="inner">');
    // Sibling outside the preserved subtree scopes normally
    expect(body).toContain('bascik__comp-vendor__');
    expect(body).not.toContain('<p id="outer"');
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

describe("recursivelyTranspile – prop attribute scoping", () => {
  it("scopes injected id and name per instance while deduplicating class", () => {
    (BascikConfig as any).scoping = {
      scriptBlocks: false,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const componentList = {
      "bound-field": {
        fileName: "components/bound-field.html",
        fileContent:
          '<input data-bascik-attr-id="id" data-bascik-attr-name="name" data-bascik-attr-class="class">',
      },
    };
    const result = recursivelyTranspile(
      '<bound-field data-bascik-prop-id="field" data-bascik-prop-name="group" data-bascik-prop-class="control"></bound-field>' +
      '<bound-field data-bascik-prop-id="field" data-bascik-prop-name="group" data-bascik-prop-class="control"></bound-field>',
      componentList,
    ).transpiledHtmlBody;

    const idMatches = result.match(/id="bascik__bound-field__([0-9a-f]+)__field"/g);
    expect(idMatches).toHaveLength(2);
    expect(idMatches![0]).not.toBe(idMatches![1]);

    const nameMatches = result.match(/name="bascik__bound-field__([0-9a-f]+)__group"/g);
    expect(nameMatches).toHaveLength(2);
    expect(nameMatches![0]).not.toBe(nameMatches![1]);

    expect(result.match(/class="bascik__bound-field__control"/g)).toHaveLength(2);
  });

  it("transpiling the same page twice produces byte-identical output", () => {
    (BascikConfig as any).scoping = {
      scriptBlocks: false,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const componentList = {
      "card-item": {
        name: "card-item",
        fileName: "components/card-item.html",
        fileContent: '<div id="card-box" name="card-field"><h1 class="title">Title</h1></div>',
      },
    };
    const pageHtml = '<card-item></card-item><card-item></card-item>';
    const first = recursivelyTranspile(pageHtml, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    const second = recursivelyTranspile(pageHtml, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    expect(first).toBe(second);
  });

  it("adding a component earlier shifts later IDs predictably and repeatedly", () => {
    (BascikConfig as any).scoping = {
      scriptBlocks: false,
      inheritAttributes: true,
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    };
    const componentList = {
      "card-item": {
        name: "card-item",
        fileName: "components/card-item.html",
        fileContent: '<div id="card-box" name="card-field"></div>',
      },
    };
    const pageHtml1 = '<card-item></card-item>';
    const pageHtml2 = '<card-item></card-item><card-item></card-item>';
    const run1 = recursivelyTranspile(pageHtml2, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    const run2 = recursivelyTranspile(pageHtml2, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    expect(run1).toBe(run2);

    const single = recursivelyTranspile(pageHtml1, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    expect(run1.startsWith(single)).toBe(true);
  });
});

describe("recursivelyTranspile – flat string output (prompt 85)", () => {
  const componentList = {
    "list-row": {
      name: "list-row",
      fileName: "components/list-row.html",
      fileContent: '<li class="row"><row-badge></row-badge><span data-bascik-prop-label></span></li>',
    },
    "row-badge": {
      name: "row-badge",
      fileName: "components/row-badge.html",
      fileContent: '<em class="badge">*</em>',
    },
  };
  const page =
    "<ul>" +
    Array.from({ length: 250 }, (_, i) => `<list-row data-bascik-prop-label="Row ${i}"></list-row>`).join("") +
    "</ul>";

  it("output is byte-identical to a fresh run and free of source-file markers", () => {
    const first = recursivelyTranspile(page, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    const second = recursivelyTranspile(page, componentList, [], "src/pages/index.html").transpiledHtmlBody;
    expect(first).toBe(second);
    expect(first).not.toContain("bascik-source-file");
    expect(first.match(/<li class="/g)).toHaveLength(250);
    expect(first.match(/<em class="/g)).toHaveLength(250);
    expect(first).toContain("<span>Row 249</span>");
  });

  it("returned body is a flat V8 string after 500 splices", async () => {
    const { isFlatString } = await import("./string-flatness-probe.test-helper.ts");
    const { transpiledHtmlBody, usedComponents } = recursivelyTranspile(page, componentList, [], "src/pages/index.html");
    expect(usedComponents).toHaveLength(500);
    expect(isFlatString(transpiledHtmlBody)).toBe(true);
  });
});

describe("dynamic routes pipeline expansion", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (BascikConfig as Record<string, unknown>).inlineStyles = false;
    (BascikConfig as Record<string, unknown>).isBuild = false;
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});
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

  it("aggregates multiple dynamic route expansion failures in build mode", async () => {
    const pages = [
      "src/pages/blog/[slug].html",
      "src/pages/products/[id].html",
      "src/pages/index.html",
    ];
    (BascikConfig as Record<string, unknown>).isBuild = true;
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const routesModule = await import("./routes.ts");
    const routesSpy = vi.spyOn(routesModule, "executeRoutesScript")
      .mockImplementation(async (_html, pagePath) => {
        throw new Error(`invalid routes in ${pagePath}`);
      });

    let buildError: unknown;
    try {
      await processAllPages({ useWorkers: false });
    } catch (error) {
      buildError = error;
    } finally {
      (BascikConfig as Record<string, unknown>).isBuild = false;
      routesSpy.mockRestore();
    }

    expect(buildError).toBeInstanceOf(AggregateError);
    const message = (buildError as Error).message;
    expect(message).toContain("src/pages/blog/[slug].html");
    expect(message).toContain("src/pages/products/[id].html");
    expect(message).toContain("expand routes");
  });

  it("completes a dev batch when multiple dynamic route expansions fail", async () => {
    const pages = [
      "src/pages/blog/[slug].html",
      "src/pages/products/[id].html",
      "src/pages/index.html",
    ];
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue(pages);
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(PAGE_HTML);
    const routesModule = await import("./routes.ts");
    const routesSpy = vi.spyOn(routesModule, "executeRoutesScript")
      .mockImplementation(async (_html, pagePath) => {
        throw new Error(`invalid routes in ${pagePath}`);
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

    const result = await processAllPages({ useWorkers: false });

    expect(result).toEqual(["pages/index.html"]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("src/pages/blog/[slug].html"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("src/pages/products/[id].html"));
    errorSpy.mockRestore();
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
          '<div class="badge"><script data-bascik-build="page">console.log("<span>" + process.env.BASCIK_PAGE_PATH + "</span>")</script><script data-bascik-server>return "server"</script></div>',
      },
    };

    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return "<!DOCTYPE html><html><head></head><body><page-badge></page-badge></body></html>";
    });

    const resultA = await transpilePage("src/pages/page-a.html", componentList);
    const resultB = await transpilePage("src/pages/page-b.html", componentList);

    expect(resultA?.distHtml).toContain("<span>/page-a</span>");
    expect(resultB?.distHtml).toContain("<span>/page-b</span>");
    expect(collectAllScriptDeps).toHaveBeenCalledWith(
      expect.stringContaining("data-bascik-build"),
      resolve(process.cwd(), "src/components/page-badge.html"),
    );
    expect(executeBuildScripts).toHaveBeenCalledWith(
      expect.stringMatching(/data-bascik-(?:build|server)[^>]*data-bascik-source-file="src%2Fcomponents%2Fpage-badge.html"/),
      "src/pages/page-a.html",
      undefined,
      expect.objectContaining({ pageFile: "src/pages/page-a.html" }),
    );
    expect(executeBuildScripts).toHaveBeenCalledWith(
      expect.stringMatching(/data-bascik-server[^>]*data-bascik-source-file="src%2Fcomponents%2Fpage-badge.html"/),
      "src/pages/page-a.html",
      undefined,
      expect.objectContaining({ pageFile: "src/pages/page-a.html" }),
    );
  });

  it("annotates component server scripts with their authored line offset", async () => {
    const { executeBuildScripts } = await import("./build-scripts.ts");
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockImplementation(async (html: string) => html);
    const componentList = {
      "line-card": {
        fileName: "src/components/line-card.html",
        fileContent: `<article>
  <h2>Line card</h2>
  <p>Authored before the script.</p>
  <script data-bascik-server>
throw new Error("component failure");
  </script>
  <script data-bascik-build="page">return "";</script>
</article>`,
      },
    };
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      `<!DOCTYPE html><html><head></head><body>${"<p>consumer spacing</p>\n".repeat(20)}<line-card></line-card></body></html>`,
    );

    await transpilePage("src/pages/consumer.html", componentList);

    expect(executeBuildScripts).toHaveBeenCalledWith(
      expect.stringMatching(
        /data-bascik-server[^>]*data-bascik-source-file="src%2Fcomponents%2Fline-card.html"[^>]*data-bascik-source-line="4"/,
      ),
      "src/pages/consumer.html",
      undefined,
      expect.objectContaining({ pageFile: "src/pages/consumer.html" }),
    );
  });

  it("executes a page-aware build script inside a nested child named slot", async () => {
    const { executeBuildScripts } = await import("./build-scripts.ts");
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockImplementation(
      async (html: string) => html.replace(
        /<script\b[^>]*\bdata-bascik-build[^>]*>[\s\S]*?<\/script>/gi,
        "<strong>page-aware source</strong>",
      ),
    );
    const componentList = {
      "outer-shell": {
        fileName: "src/components/outer-shell.html",
        fileContent:
          '<section><inner-demo><div data-bascik-slot="source-html"><code-block><script data-bascik-build="page">console.log("page-aware source")</script></code-block></div></inner-demo></section>',
      },
      "inner-demo": {
        fileName: "src/components/inner-demo.html",
        fileContent:
          '<article><div data-bascik-slot="source-html">fallback</div></article>',
      },
      "code-block": {
        fileName: "src/components/code-block.html",
        fileContent: '<pre data-code-block><div data-bascik-slot></div></pre>',
      },
    };
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      "<!DOCTYPE html><html><head></head><body><outer-shell></outer-shell></body></html>",
    );

    const result = await transpilePage("src/pages/nested-demo.html", componentList);

    expect(result?.distHtml).toContain(
      '<article><pre data-code-block><strong>page-aware source</strong></pre></article>',
    );
    expect(executeBuildScripts).toHaveBeenCalledWith(
      expect.stringMatching(/data-bascik-build="page"/),
      "src/pages/nested-demo.html",
      undefined,
      expect.objectContaining({ pageFile: "src/pages/nested-demo.html" }),
    );
  });
});

describe("monotonic dev publication & concurrency overlap", () => {
  const PAGE_ABS = resolve(process.cwd(), "src/pages/index.html");
  const PAGE_REL = "src/pages/index.html";

  beforeEach(async () => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
    (mem.storePage as ReturnType<typeof vi.fn>).mockClear();
    (mem.removePage as ReturnType<typeof vi.fn>).mockClear();
    (mem.removeByRelativePath as ReturnType<typeof vi.fn>).mockClear();
    const eventsModule = await import("./events.ts");
    (eventsModule.eventEmitter.emit as ReturnType<typeof vi.fn>).mockClear();
  });

  it("drops a stale batch completion when a newer direct pageProcessing has already published", async () => {
    const eventsModule = await import("./events.ts");
    let releaseBatchRead!: () => void;
    const batchReadGate = new Promise<void>((res) => {
      releaseBatchRead = res;
    });

    const OLD_HTML = "<!DOCTYPE html><html><head></head><body><h1>OLD BATCH</h1></body></html>";
    const NEW_HTML = "<!DOCTYPE html><html><head></head><body><h1>NEW DIRECT</h1></body></html>";

    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async (filePath: string) => {
      if (filePath.includes("index.html")) {
        // If gate not released, this is the batch read
        await batchReadGate;
        return OLD_HTML;
      }
      return "<!DOCTYPE html><html><head></head><body>default</body></html>";
    });

    // 1. Start batch processing with older content deferred
    const batchPromise = processPageBatch([PAGE_ABS], {});

    // 2. Direct pageProcessing arrives with newer content
    // We override readFile temporarily for the direct transpile
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(NEW_HTML);
    const directPromise = pageProcessing(PAGE_ABS, {});

    await directPromise;

    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageContent: expect.stringContaining("NEW DIRECT"),
      }),
    );
    const storeCountAfterDirect = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls.length;
    const emitCountAfterDirect = (eventsModule.eventEmitter.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "transpiled",
    ).length;

    // 3. Release older batch read and await its completion
    releaseBatchRead();
    await batchPromise;

    // Stale batch must NOT overwrite memory store or re-emit transpiled reload event
    expect(mem.storePage).toHaveBeenCalledTimes(storeCountAfterDirect);
    const emitCountAfterBatch = (eventsModule.eventEmitter.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "transpiled",
    ).length;
    expect(emitCountAfterBatch).toBe(emitCountAfterDirect);
  });

  it("gives a queued direct page edit ownership over an older broad rebuild", async () => {
    const eventsModule = await import("./events.ts");
    let releaseBatchRead!: () => void;
    const batchReadGate = new Promise<void>((resolveGate) => {
      releaseBatchRead = resolveGate;
    });

    const OLD_HTML = "<!DOCTYPE html><html><head></head><body><h1>OLD COMPONENT REBUILD</h1></body></html>";
    const NEW_HTML = "<!DOCTYPE html><html><head></head><body><h1>NEW QUEUED PAGE EDIT</h1></body></html>";
    let indexReadCount = 0;
    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async (filePath: string) => {
      if (!filePath.includes("index.html")) {
        return "<!DOCTYPE html><html><head></head><body>default</body></html>";
      }
      indexReadCount++;
      if (indexReadCount === 1) {
        await batchReadGate;
        return OLD_HTML;
      }
      return NEW_HTML;
    });

    const broadRebuild = processPageBatch([PAGE_ABS], {});
    await vi.waitFor(() => expect(indexReadCount).toBe(1));

    // The page watcher observes the newer edit while the older component
    // rebuild is still reading. Ownership must transfer at enqueue time.
    const directEdit = pageProcessing(PAGE_ABS, {});
    releaseBatchRead();

    await broadRebuild;
    await directEdit;

    const storedPages = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls.map(
      ([input]) => String(input.pageContent),
    );
    expect(storedPages.some((content) => content.includes("OLD COMPONENT REBUILD"))).toBe(false);
    expect(storedPages.some((content) => content.includes("NEW QUEUED PAGE EDIT"))).toBe(true);

    const transpiledEvents = (eventsModule.eventEmitter.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([event]) => event === "transpiled",
    );
    expect(transpiledEvents).toHaveLength(1);
  });

  it("drops a stale batch completion when a newer batch for the same page has published", async () => {
    let releaseBatch1Read!: () => void;
    const batch1ReadGate = new Promise<void>((res) => {
      releaseBatch1Read = res;
    });

    const OLD_HTML = "<!DOCTYPE html><html><head></head><body><h1>OLD BATCH 1</h1></body></html>";
    const NEW_HTML = "<!DOCTYPE html><html><head></head><body><h1>NEW BATCH 2</h1></body></html>";

    let readCallCount = 0;
    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      readCallCount++;
      if (readCallCount === 1) {
        await batch1ReadGate;
        return OLD_HTML;
      }
      return NEW_HTML;
    });

    const batch1Promise = processPageBatch([PAGE_ABS], {});

    // Batch 2 starts after Batch 1 and finishes first
    const batch2Promise = processPageBatch([PAGE_ABS], {});

    await batch2Promise;

    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageContent: expect.stringContaining("NEW BATCH 2"),
      }),
    );
    const storeCountAfterBatch2 = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls.length;

    releaseBatch1Read();
    await batch1Promise;

    expect(mem.storePage).toHaveBeenCalledTimes(storeCountAfterBatch2);
  });

  it("handles relative and absolute path aliases under the same canonical generation ownership", async () => {
    let releaseBatchRead!: () => void;
    const batchReadGate = new Promise<void>((res) => {
      releaseBatchRead = res;
    });

    const OLD_HTML = "<!DOCTYPE html><html><head></head><body><h1>OLD BATCH</h1></body></html>";
    const NEW_HTML = "<!DOCTYPE html><html><head></head><body><h1>NEW DIRECT REL</h1></body></html>";

    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await batchReadGate;
      return OLD_HTML;
    });

    // Start batch with absolute path
    const batchPromise = processPageBatch([PAGE_ABS], {});

    // Direct pageProcessing with relative path
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(NEW_HTML);
    const directPromise = pageProcessing(PAGE_REL, {});

    await directPromise;

    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageContent: expect.stringContaining("NEW DIRECT REL"),
      }),
    );
    const storeCountAfterDirect = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls.length;

    releaseBatchRead();
    await batchPromise;

    expect(mem.storePage).toHaveBeenCalledTimes(storeCountAfterDirect);
  });

  it("does not resurrect a deleted page if an older compilation finishes after deletion", async () => {
    let releaseBatchRead!: () => void;
    const batchReadGate = new Promise<void>((res) => {
      releaseBatchRead = res;
    });

    const OLD_HTML = "<!DOCTYPE html><html><head></head><body><h1>OLD REMOVED</h1></body></html>";

    (readFile as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await batchReadGate;
      return OLD_HTML;
    });

    const batchPromise = processPageBatch([PAGE_ABS], {});

    // Page is deleted while compilation is in-flight
    await removePage(PAGE_ABS);
    expect(mem.removePage).toHaveBeenCalledWith(PAGE_ABS);

    const storeCountAfterDelete = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls.length;

    releaseBatchRead();
    await batchPromise;

    // Must NOT store or resurrect the removed page
    expect(mem.storePage).toHaveBeenCalledTimes(storeCountAfterDelete);
  });

  it("drops stale worker completion if newer direct transpile finished first", async () => {
    const { WorkerPool } = await import("./worker-pool.ts");
    const { listPages } = await import("./file-system.ts");
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValueOnce([PAGE_ABS]);
    const componentsModule = await import("./components.ts");
    vi.spyOn(componentsModule, "listComponents").mockResolvedValue({});

    let releaseWorkerRun!: () => void;
    let markWorkerEntered!: () => void;
    const workerRunGate = new Promise<void>((res) => {
      releaseWorkerRun = res;
    });
    const workerEntered = new Promise<void>((res) => {
      markWorkerEntered = res;
    });

    (WorkerPool as ReturnType<typeof vi.fn>).mockImplementationOnce(function (this: any) {
      this.run = vi.fn(async () => {
        markWorkerEntered();
        await workerRunGate;
        return {
          relativePagePath: "pages/index.html",
          absolutePagePath: PAGE_ABS,
          distHtmlBytes: new TextEncoder().encode("<html><body>WORKER OLD</body></html>"),
          usedComponentsNames: [],
          fileDependencies: [],
        };
      });
      this.terminate = vi.fn(async () => { });
    });

    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue("<html><body>test</body></html>");

    // Start processAllPages with worker mode
    const allPagesPromise = processAllPages({ useWorkers: true });
    await workerEntered;

    // While worker is paused, direct pageProcessing runs with newer HTML
    const NEW_HTML = "<!DOCTYPE html><html><head></head><body><h1>NEW DIRECT OVER WORKER</h1></body></html>";
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(NEW_HTML);
    const directPromise = pageProcessing(PAGE_ABS, {});

    await directPromise;

    expect(mem.storePage).toHaveBeenCalledWith(
      expect.objectContaining({
        pageContent: expect.stringContaining("NEW DIRECT OVER WORKER"),
      }),
    );
    const storeCountAfterDirect = (mem.storePage as ReturnType<typeof vi.fn>).mock.calls.length;

    releaseWorkerRun();
    await allPagesPromise;

    expect(mem.storePage).toHaveBeenCalledTimes(storeCountAfterDirect);
  });
});

describe("prompt 99: failed import dependency recovery", () => {
  const PAGE_ABS = resolve(process.cwd(), "src/pages/missing-import.html");

  beforeEach(async () => {
    (BascikConfig as Record<string, unknown>).isBuild = false;
    const { executeBuildScripts, collectAllScriptDeps } = await import("./build-scripts.ts");
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockReset();
    (collectAllScriptDeps as ReturnType<typeof vi.fn>).mockReset();
    (mem.recordFailedDependencies as ReturnType<typeof vi.fn>).mockClear();
  });

  it("records attempted dependencies when a page build throws on a missing import", async () => {
    const { executeBuildScripts, collectAllScriptDeps } = await import("./build-scripts.ts");
    const html = '<html><body><script data-bascik-build>import x from "@/lib/new-helper.ts";</script></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(html);
    (collectAllScriptDeps as ReturnType<typeof vi.fn>).mockResolvedValue(["src/lib/new-helper.ts"]);
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Cannot find module '/abs/src/lib/new-helper.ts'"),
    );

    await expect(transpilePage(PAGE_ABS, {})).rejects.toThrow();
    expect(mem.recordFailedDependencies).toHaveBeenCalledWith(
      PAGE_ABS,
      ["src/lib/new-helper.ts"],
    );
  });

  it("records failed dependencies so a compilation watcher rebuilds the page when the helper appears", async () => {
    const { executeBuildScripts, collectAllScriptDeps } = await import("./build-scripts.ts");
    const missingHtml = '<html><body><script data-bascik-build>import x from "@/lib/new-helper.ts";</script></body></html>';
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(missingHtml);
    (collectAllScriptDeps as ReturnType<typeof vi.fn>).mockResolvedValue(["src/lib/new-helper.ts"]);
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Cannot find module '/abs/src/lib/new-helper.ts'"),
    );

    await expect(transpilePage(PAGE_ABS, {})).rejects.toThrow();
    expect(mem.recordFailedDependencies).toHaveBeenCalled();

    // Now the helper exists; the page compiles and imports it successfully,
    // so the page's successful dependencies are recorded and its failed-deps
    // are cleared by storePage on publication.
    (readFile as ReturnType<typeof vi.fn>).mockResolvedValue(missingHtml);
    (executeBuildScripts as ReturnType<typeof vi.fn>).mockResolvedValueOnce(missingHtml);
    const result = await transpilePage(PAGE_ABS, {});
    expect(result).not.toBeNull();
  });
});
