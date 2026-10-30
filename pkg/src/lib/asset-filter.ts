import { matchesGlob, relative } from "node:path";
import { BascikConfig } from "./config.ts";
import { isPrivatePathname } from "./route-matching.ts";

const STATIC_ASSET_DENIED_EXTENSIONS = new Set([
  ".html",
  ".ts",
  ".map",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".md",
]);

export const isInlineStylesheet = (path: string): boolean => {
  const inlineStyles = BascikConfig.assets?.inlineStyles;
  if (!inlineStyles) return false;
  if (!path.endsWith(".css")) return false;
  if (inlineStyles === true) return true;
  if (Array.isArray(inlineStyles)) {
    const normalizedPath = path.replace(/\\/g, "/");
    return inlineStyles.some((stylePath) => {
      const normalizedStyle = stylePath.replace(/\\/g, "/");
      return (
        normalizedPath === normalizedStyle ||
        normalizedPath.endsWith("/" + normalizedStyle) ||
        normalizedStyle.endsWith("/" + normalizedPath)
      );
    });
  }
  return false;
};

export const isStaticAssetPath = (
  filePath: string,
  sourceRoot = BascikConfig.directory.pages,
  applyConfiguredExcludes = true,
): boolean => {
  const relativePath = relative(sourceRoot, filePath).replace(/\\/g, "/");
  if (relativePath === ".." || relativePath.startsWith("../")) return false;

  // Dotfiles and dot-directories never publish, except a top-level RFC 8615
  // `.well-known/` directory, which is copied to `<out>/.well-known/`. With
  // `security.hideDotfiles` off they do, except a top-level `.bascik/` (the
  // build's own folder in the output); node_modules never does.
  const segments = relativePath.split("/").filter(Boolean);
  if (
    isPrivatePathname(
      relativePath,
      "/",
      BascikConfig.security?.hideDotfiles !== false,
    ) ||
    segments.includes("node_modules")
  ) {
    return false;
  }
  if (!/\.[a-zA-Z0-9]+$/.test(relativePath)) return false;

  const extension = relativePath
    .slice(relativePath.lastIndexOf("."))
    .toLowerCase();
  const isConfiguredExclude =
    applyConfiguredExcludes &&
    (BascikConfig.assets?.exclude ?? []).some((pattern) =>
      matchesGlob(relativePath, pattern),
    );
  return (
    !STATIC_ASSET_DENIED_EXTENSIONS.has(extension) &&
    !/\.(test|spec)\.[a-zA-Z0-9]+$/i.test(relativePath) &&
    !isInlineStylesheet(filePath) &&
    !isConfiguredExclude
  );
};
