import { relative } from "node:path";
import { BascikConfig } from "./config.ts";
import { trimSlashes, trimTrailingSlashes } from "./slashes.ts";

/** Convert a page filename to its canonical decoded URL path. Directory indexes use a trailing slash. */
export const getHttpPath = (
  pagePath: string,
  pagesDir: string = BascikConfig.directory.pages,
): string => {
  let normalized = pagePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const normalizedPagesDir = trimTrailingSlashes(pagesDir.replace(/\\/g, "/"));
  const configuredRelativeDir = relative(process.cwd(), normalizedPagesDir).replace(/\\/g, "/");
  const sourceRoots = new Set([
    normalizedPagesDir,
    configuredRelativeDir,
    "pages",
  ]);

  let leadingRootLength = -1;
  for (const sourceRoot of sourceRoots) {
    const variants = [trimTrailingSlashes(sourceRoot), trimSlashes(sourceRoot)];
    for (const root of variants) {
      if (root && normalized.startsWith(`${root}/`)) {
        leadingRootLength = Math.max(leadingRootLength, root.length + 1);
      }
    }
  }

  if (leadingRootLength >= 0) {
    normalized = normalized.slice(leadingRootLength);
  } else {
    let relativeStart = -1;
    for (const sourceRoot of sourceRoots) {
      const root = trimSlashes(sourceRoot);
      if (!root) continue;
      const marker = `/${root}/`;
      const markerIndex = normalized.lastIndexOf(marker);
      if (markerIndex >= 0) {
        relativeStart = Math.max(relativeStart, markerIndex + marker.length);
      }
    }
    normalized = relativeStart >= 0
      ? normalized.slice(relativeStart)
      : normalized.replace(/^\/+/, "");
  }

  const route = normalized.replace(/\.html$/i, "");
  if (route === "index" || route === "") return "/";
  if (route.endsWith("/index")) return `/${route.slice(0, -"index".length)}`;

  return `/${route}`;
};
