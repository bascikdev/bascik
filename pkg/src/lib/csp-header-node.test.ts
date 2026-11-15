import { describe, it, expect, vi, beforeEach } from "vitest";

const { config } = vi.hoisted(() => ({
  config: {
    isBuild: false,
    isProdServer: false,
    directory: { out: "/project/dist", pages: "/project/src/pages" },
    contentSecurityPolicy: undefined as
      { directives: Record<string, string[]> } | undefined,
  },
}));

vi.mock("./config.ts", () => ({ BascikConfig: config }));
vi.mock("./paths.ts", () => ({
  getHttpPath: (relativePagePath: string) =>
    `/${relativePagePath.replace(/^pages\//, "").replace(/(index)?\.html$/, "")}`,
}));

import { cspHeadersForPage } from "./csp-header-node.ts";
import { cspHashCollector } from "./csp-hashes.ts";

const HEADER = "content-security-policy";
const OLD_SCRIPT = "sha256-oldScriptHashOfThePreviousBuildOfThisPage000=";
const NEW_SCRIPT = "sha256-newScriptHashOfTheBuildNowInTheStore0000000=";
const NEW_STYLE = "sha256-newStyleHashOfTheBuildNowInTheStore00000000=";

const headerOf = (page: Parameters<typeof cspHeadersForPage>[0]): string =>
  Object.entries(cspHeadersForPage(page)).find(
    ([name]) => name.toLowerCase() === HEADER,
  )?.[1] ?? "";

beforeEach(() => {
  config.isProdServer = false;
  config.contentSecurityPolicy = { directives: { "default-src": ["'self'"] } };
  cspHashCollector.clear();
});

describe("cspHeadersForPage on the dev server", () => {
  it("sends no header when contentSecurityPolicy is unset", () => {
    config.contentSecurityPolicy = undefined;
    expect(
      cspHeadersForPage({
        relativePagePath: "pages/index.html",
        cspHashes: { scripts: [NEW_SCRIPT], styles: [] },
      }),
    ).toEqual({});
  });

  it("uses the hashes stored with the page before its disk write has recorded them", () => {
    // The page is servable as soon as it is in the memory store. Its queued
    // disk write, which records the route's hashes in the collector, has not
    // run yet: the collector knows nothing about the route.
    const header = headerOf({
      relativePagePath: "pages/index.html",
      cspHashes: { scripts: [NEW_SCRIPT], styles: [NEW_STYLE] },
    });
    expect(header).toContain(`script-src 'self' '${NEW_SCRIPT}'`);
    expect(header).toContain(`style-src 'self' '${NEW_STYLE}'`);
  });

  it("uses the stored page's hashes, not the previous build's, after an edit", () => {
    // After an edit the collector still holds the hashes of the page it
    // last wrote to disk, while the store already serves the new content.
    cspHashCollector.recordComputed("/", { scripts: [OLD_SCRIPT], styles: [] });
    const header = headerOf({
      relativePagePath: "pages/index.html",
      cspHashes: { scripts: [NEW_SCRIPT], styles: [] },
    });
    expect(header).toContain(NEW_SCRIPT);
    expect(header).not.toContain(OLD_SCRIPT);
  });

  it("falls back to the collector for a page stored without hashes", () => {
    cspHashCollector.recordComputed("/about", {
      scripts: [OLD_SCRIPT],
      styles: [],
    });
    expect(headerOf({ relativePagePath: "pages/about.html" })).toContain(
      OLD_SCRIPT,
    );
  });
});
