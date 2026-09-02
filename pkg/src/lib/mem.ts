import zlib from "node:zlib";
import { relative, resolve } from "node:path";
import { getHttpPath } from "./paths.ts";
import { getRelativePath } from "./file-system.ts";
import { htmlHasServerScripts } from "./server-scripts.ts";
import { BascikConfig } from "./config.ts";
import { makeEtag } from "./names.ts";
import type { StoredPage } from "./types.ts";

interface StorePageArgs {
  relativePagePath: string;
  absolutePagePath: string;
  pageContent: string | Buffer;
  usedComponentsNames?: string[];
  fileDependencies?: string[];
}

class MemoryStore {
  #files: Map<string, StoredPage>;
  #components: Map<string, Set<string>>;
  #fileDependencies: Map<string, Set<string>>;
  /** HTTP paths of pages with an active SSE live-reload connection, with connection counts. */
  #openPages: Map<string, number>;

  constructor() {
    this.#files = new Map();
    this.#components = new Map();
    this.#fileDependencies = new Map();
    this.#openPages = new Map();
  }

  async storePage({
    relativePagePath,
    absolutePagePath,
    pageContent,
    usedComponentsNames = [],
    fileDependencies = [],
  }: StorePageArgs): Promise<void> {
    const httpPath = getHttpPath(relativePagePath);

    const buffer = Buffer.isBuffer(pageContent) ? pageContent : Buffer.from(pageContent, "utf8");

    const usedComponentsSet = new Set(usedComponentsNames);
    const fileDependenciesSet = new Set(
      fileDependencies.map((dep) =>
        relative(process.cwd(), resolve(process.cwd(), dep)).replace(/\\/g, "/"),
      ),
    );

    const originalUsedComponentSet = new Set(
      this.#files.get(httpPath)?.usedComponentsSet,
    );
    const originalFileDependenciesSet = new Set(
      this.#files.get(httpPath)?.fileDependenciesSet,
    );

    // Store the raw content immediately so the page is servable right away.
    // Brotli compression (quality 11 is CPU-heavy) is computed in the
    // background below and does not block "page ready" — the server falls
    // back to uncompressed content until compression finishes.
    this.#files.set(httpPath, {
      relativePagePath,
      absolutePagePath,
      content: buffer,
      etag: makeEtag(buffer),
      compressedContent: undefined,
      usedComponentsSet,
      fileDependenciesSet,
      hasServerScripts: htmlHasServerScripts(pageContent),
    });

    // Invert map for reverse lookup to efficiently know what files to update
    // Create entries in the map for each component name,
    // and add this file to a Set associated with the component.
    usedComponentsSet.forEach((componentName: string) => {
      if (!this.#components.has(componentName)) {
        this.#components.set(componentName, new Set());
      }
      this.#components.get(componentName)!.add(absolutePagePath);
    });

    // If a page no longer has component, remove that page from the component's set.
    //  ex: pageA has tag1 and tag2. then tag2 is removed from pageA.
    // tag2 should remove pageA from it's set.
    originalUsedComponentSet
      .difference(usedComponentsSet)
      .forEach((unusedComponent: string) => {
        this.#components.get(unusedComponent)?.delete(absolutePagePath);
      });

    fileDependenciesSet.forEach((depPath: string) => {
      if (!this.#fileDependencies.has(depPath)) {
        this.#fileDependencies.set(depPath, new Set());
      }
      this.#fileDependencies.get(depPath)!.add(absolutePagePath);
    });

    originalFileDependenciesSet
      .difference(fileDependenciesSet)
      .forEach((unusedDep: string) => {
        this.#fileDependencies.get(unusedDep)?.delete(absolutePagePath);
      });

    // Fire-and-forget: compress in the background and attach the result once
    // done. In dev mode, quality 1 (min) is 200x faster than quality 11 (max)
    // and avoids queuing heavy zlib tasks that delay dev server shutdown.
    const quality = BascikConfig.isBuild
      ? zlib.constants.BROTLI_MAX_QUALITY
      : zlib.constants.BROTLI_MIN_QUALITY;
    zlib.brotliCompress(
      buffer,
      { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality } },
      (err, compressed) => {
        if (err) return;
        const current = this.#files.get(httpPath);
        if (current && current.content === buffer) {
          current.compressedContent = compressed;
        }
      },
    );

    //console.log('stored page in memory:', httpPath)
  }

  getPage(httpPath: string): StoredPage | undefined {
    return this.#files.get(httpPath) || this.#files.get("/404");
  }

  /**
   * Exact lookup only — no 404 fallback. Lets the HTTP layer try path
   * normalizations (`/blog` vs `/blog/`) before falling back to the 404 page.
   */
  getPageExact(httpPath: string): StoredPage | undefined {
    const page = this.#files.get(httpPath);
    if (page) return page;

    if (httpPath.length > 1 && httpPath.endsWith("/")) {
      return this.#files.get(httpPath.slice(0, -1));
    }
    return this.#files.get(`${httpPath}/`);
  }

  removePage(absolutePagePath: string): void {
    const toDelete: string[] = [];
    for (const [httpPath, page] of this.#files.entries()) {
      if (page.absolutePagePath === absolutePagePath) {
        page.usedComponentsSet.forEach((componentName: string) => {
          this.#components.get(componentName)?.delete(absolutePagePath);
        });
        page.fileDependenciesSet?.forEach((depPath: string) => {
          this.#fileDependencies.get(depPath)?.delete(absolutePagePath);
        });
        toDelete.push(httpPath);
      }
    }
    for (const httpPath of toDelete) {
      this.#files.delete(httpPath);
    }
  }

  removeByRelativePath(relativePagePath: string): void {
    const httpPath = getHttpPath(relativePagePath);
    const page = this.#files.get(httpPath);
    if (!page) return;
    page.usedComponentsSet.forEach((componentName: string) => {
      this.#components.get(componentName)?.delete(page.absolutePagePath);
    });
    page.fileDependenciesSet?.forEach((depPath: string) => {
      this.#fileDependencies.get(depPath)?.delete(page.absolutePagePath);
    });
    this.#files.delete(httpPath);
  }

  pagesThisComponentIsUsedOn(componentName: string): string[] {
    const pagesSet = this.#components.get(componentName);
    if (pagesSet) return [...pagesSet];
    return [];
  }

  pagesDependentOnFile(changedPath: string): string[] {
    if (!changedPath) return [];
    const normalized = relative(process.cwd(), resolve(process.cwd(), changedPath)).replace(/\\/g, "/");
    const pagesSet = this.#fileDependencies.get(normalized);
    if (pagesSet) return [...pagesSet];
    return [];
  }

  trackOpenPage(httpPath: string): void {
    this.#openPages.set(httpPath, (this.#openPages.get(httpPath) ?? 0) + 1);
  }

  untrackOpenPage(httpPath: string): void {
    const count = this.#openPages.get(httpPath);
    if (count === undefined) return;
    if (count <= 1) {
      this.#openPages.delete(httpPath);
    } else {
      this.#openPages.set(httpPath, count - 1);
    }
  }

  get openPages(): string[] {
    return [...this.#openPages.keys()];
  }

  #isBooting = true;
  /** True until the initial full-page scan completes on dev server startup. */
  get isBooting(): boolean { return this.#isBooting; }
  setBootingDone(): void { this.#isBooting = false; }
}

export const mem = new MemoryStore();
