/**
 * `security.hideDotfiles` (inventory item 32, dotfile part). On (default):
 * every dot segment is private except a leading /.well-known/. Off: dotfiles
 * from src/pages are published and served, but `.bascik/` (sidecars,
 * manifests, adapter output), `node_modules`, source maps and precompressed
 * siblings never are, and traversal still answers 400 elsewhere.
 */
import { describe, expect, it, vi, afterEach } from "vitest";

const { configState } = vi.hoisted(() => ({
  configState: {
    base: "/",
    directory: { pages: "/proj/src/pages" },
    assets: { exclude: [] as string[] },
    security: undefined as undefined | { hideDotfiles?: boolean },
  },
}));
vi.mock("./config.js", () => ({ BascikConfig: configState }));

import * as routeMatching from "./route-matching.ts";
import { isStaticAssetPath } from "./asset-filter.ts";
import { isPublicAssetPath } from "./site-graph.ts";

type IsPrivate = (
  pathname: string,
  base?: string,
  hideDotfiles?: boolean,
) => boolean;
const isPrivatePathname = (
  routeMatching as unknown as { isPrivatePathname?: IsPrivate }
).isPrivatePathname;
const isPublic = isPublicAssetPath as unknown as (
  rel: string,
  hideDotfiles?: boolean,
) => boolean;

afterEach(() => {
  configState.security = undefined;
});

describe("isPrivatePathname", () => {
  it("is exported from route-matching (and so from the runtime entry)", () => {
    expect(typeof isPrivatePathname).toBe("function");
  });

  it.each([
    ["/.env", true],
    ["/.nojekyll", true],
    ["/a/.git/config", true],
    ["/.well-known/security.txt", false],
    ["/.well-known/.env", true],
    ["/.bascik/components.json", true],
    ["/about", false],
  ])("on (default): %s private=%s, as hasHiddenSegment", (path, expected) => {
    expect(isPrivatePathname!(path, "/")).toBe(expected);
    expect(isPrivatePathname!(path, "/", true)).toBe(expected);
    expect(routeMatching.hasHiddenSegment(path, "/")).toBe(expected);
  });

  it.each([
    ["/.env", false],
    ["/.nojekyll", false],
    ["/a/.git/config", false],
    ["/.well-known/.env", false],
    ["/.bascik/components.json", true],
    ["/.bascik/cloudflare-pages/_worker.js", true],
    ["/.bascik", true],
    ["/a/.bascik/x", false],
    ["/about", false],
  ])("off: %s private=%s (only a first .bascik segment)", (path, expected) => {
    expect(isPrivatePathname!(path, "/", false)).toBe(expected);
  });

  // macOS and Windows filesystems ignore letter case, and Windows also drops
  // trailing dots and spaces, so these all open dist/.bascik on disk.
  it.each([
    "/.BASCIK/server-scripts.json",
    "/.Bascik/components.json",
    "/.bascik./server-scripts.json",
    "/.bascik /server-scripts.json",
    "/.BaScIk.. /cloudflare-pages/public/_worker.js",
  ])("off: %s is private (any case, trailing dots or spaces)", (path) => {
    expect(isPrivatePathname!(path, "/", false)).toBe(true);
    expect(isPrivatePathname!(`/docs${path}`, "/docs/", false)).toBe(true);
  });

  it("off under a base: .bascik is the first segment below the base", () => {
    expect(
      isPrivatePathname!("/docs/.bascik/components.json", "/docs/", false),
    ).toBe(true);
    expect(isPrivatePathname!("/docs/.nojekyll", "/docs/", false)).toBe(false);
  });
});

describe("isStaticAssetPath (what the build copies from src/pages)", () => {
  const page = (rel: string) => `/proj/src/pages/${rel}`;

  it("on: dotfiles are not published", () => {
    expect(isStaticAssetPath(page(".nojekyll"))).toBe(false);
    expect(isStaticAssetPath(page(".hidden/a.css"))).toBe(false);
    expect(isStaticAssetPath(page(".well-known/security.txt"))).toBe(true);
  });

  it("off: dotfiles are published", () => {
    configState.security = { hideDotfiles: false };
    expect(isStaticAssetPath(page(".nojekyll"))).toBe(true);
    expect(isStaticAssetPath(page(".hidden/a.css"))).toBe(true);
    expect(isStaticAssetPath(page("assets/.keep.txt"))).toBe(true);
  });

  it("off: node_modules, source maps and denied extensions still are not", () => {
    configState.security = { hideDotfiles: false };
    expect(isStaticAssetPath(page("node_modules/x/a.css"))).toBe(false);
    expect(isStaticAssetPath(page(".hidden/a.map"))).toBe(false);
    expect(isStaticAssetPath(page(".hidden/a.ts"))).toBe(false);
  });
});

describe("isPublicAssetPath (what an adapter deploys from dist)", () => {
  it("on (default): dotfiles are private", () => {
    expect(isPublic(".nojekyll")).toBe(false);
    expect(isPublic(".nojekyll", true)).toBe(false);
  });

  it("off: dotfiles deploy", () => {
    expect(isPublic(".nojekyll", false)).toBe(true);
    expect(isPublic("assets/.keep", false)).toBe(true);
  });

  it.each([
    ".bascik/components.json",
    ".bascik/server-scripts.json",
    "app.js.map",
    "index.html.br",
    "index.html.gz",
    "a.bmeta",
  ])("off: %s still never deploys", (rel) => {
    expect(isPublic(rel, false)).toBe(false);
  });
});
