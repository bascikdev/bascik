import { readdir, rm, mkdir, copyFile, readFile, writeFile, stat, realpath } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { BascikConfig, shouldLog } from "./config.ts";
import { displayComponentRoot, findComponentRoot, getComponentRoots } from "./component-roots.ts";
import { minifyCss } from "./css-minifier.ts";
import { minifyJs } from "./js-minifier.ts";
import { isStaticAssetPath } from "./asset-filter.ts";
import { rewriteCssBasePaths, rewriteManifestBasePaths } from "./base-path.ts";
import { manifestCollector } from "./manifest.ts";

export { isInlineStylesheet, isStaticAssetPath } from "./asset-filter.ts";

/**
 * Strip a `<configuredDir>/` marker from a normalized path. Uses the LAST
 * occurrence so a path like `/Users/x/my-pages/pages/a.png` keeps only the
 * tail after the real directory.
 */
const stripDirMarker = (normalizedPath: string, configuredDir: string): string => {
  const marker = `${configuredDir}/`;
  const markerIndex = normalizedPath.lastIndexOf(marker);
  const suffix = markerIndex >= 0 ? normalizedPath.slice(markerIndex + marker.length) : normalizedPath;
  return suffix.replace(/^\.?\//, "").replace(/^\//, "");
};

/**
 * Resolve an absolute path to a `parentDir/...` relative path, normalizing
 * separators. For components, the owning root comes from `findComponentRoot`;
 * a root outside the project is displayed cwd-relative
 * (`../shared/components/x.html`), never as an absolute path.
 */
export const getRelativePath = (path: string, parentDir: "pages" | "components"): string => {
  const normalizedPath = path.replace(/\\/g, "/");

  if (normalizedPath === parentDir) return parentDir;

  if (normalizedPath.startsWith(`${parentDir}/`)) {
    const relative = normalizedPath.slice(parentDir.length + 1).replace(/^\.?\//, "").replace(/^\//, "");
    return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
  }

  if (parentDir === "pages") {
    const configuredDir = BascikConfig.directory.pages.replace(/\\/g, "/");
    if (normalizedPath === configuredDir) return parentDir;
    const relative = stripDirMarker(normalizedPath, configuredDir);
    return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
  }

  const owningRoot = findComponentRoot(normalizedPath);
  if (owningRoot !== undefined) {
    const prefix = displayComponentRoot(owningRoot);
    const relative = normalizedPath.slice(owningRoot.length).replace(/^\/+/, "");
    return relative ? `${prefix}/${relative}`.replace(/\/+/g, "/") : prefix;
  }

  // No configured root contains the path (relative roots in tests, or a
  // path handed over in a different spelling): fall back to marker matching
  // against each configured root in turn.
  for (const root of getComponentRoots()) {
    if (normalizedPath === root) return parentDir;
    if (normalizedPath.lastIndexOf(`${root}/`) >= 0) {
      const relative = stripDirMarker(normalizedPath, root);
      return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
    }
  }
  const relative = normalizedPath.replace(/^\.?\//, "").replace(/^\//, "");
  return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
};

const displayRelativePath = (path: string): string => {
  const normalized = path.replace(/\\/g, "/");
  const pagesDir = BascikConfig.directory.pages.replace(/\\/g, "/");

  if (normalized.includes(`/${pagesDir}/`)) {
    return `pages/${normalized.split(`/${pagesDir}/`)[1]}`;
  }
  if (normalized.startsWith(`${pagesDir}/`)) {
    return normalized;
  }
  const owningRoot = findComponentRoot(normalized);
  if (owningRoot !== undefined) {
    const rel = normalized.slice(owningRoot.length).replace(/^\/+/, "");
    return `${displayComponentRoot(owningRoot)}/${rel}`;
  }
  for (const componentsDir of getComponentRoots()) {
    if (normalized.includes(`/${componentsDir}/`)) {
      return `components/${normalized.split(`/${componentsDir}/`)[1]}`;
    }
    if (normalized.startsWith(`${componentsDir}/`)) {
      return normalized;
    }
  }
  const outDirRel = relative(process.cwd(), BascikConfig.directory.out) || "dist";
  return normalized.replace(/^\.\//, "").replace(/^\//, "").replace(new RegExp(`^${outDirRel}/`), "");
};

/** Stream-hash a file using SHA-256. Only used for change detection. */
async function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });

    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Copies a file from src to destRoot, replicating its relative path from 'pages/'.
 * Only copies if the contents differ.
 */
export async function copyReplicatePath(
  src: string,
  destRoot: string,
): Promise<void> {
  const relativePath = getRelativePath(src, "pages");
  const relativePathWithoutPagesDir = relativePath.replace(/^pages[\\/]/, "");
  const destPath = resolve(destRoot, relativePathWithoutPagesDir);
  const destDir = dirname(destPath);

  // Make dir path for file
  await mkdir(destDir, { recursive: true });

  // Helper: compare generated/transformed text hash with destination file hash and write if changed
  const writeIfChanged = async (content: string, isMinified = false): Promise<void> => {
    const destHash = createHash("sha256").update(await readFile(destPath).catch(() => "")).digest("hex");
    const contentHash = createHash("sha256").update(content).digest("hex");
    manifestCollector.recordFile(destPath, content);
    if (contentHash === destHash) return;
    await writeFile(destPath, content);
    if (canLogDevEvent(BascikConfig.logging?.copies, "info")) {
      console.log(isMinified ? "copied (minified):" : "copied:", displayRelativePath(src));
    }
  };

  // Only copy if file hashes differ
  try {
    const isMinifyCss = BascikConfig.minify?.css ?? false;
    const minifyJsCfg = BascikConfig.minify?.js ?? false;
    const isCss = src.endsWith(".css");
    const isWebManifest = src.endsWith(".webmanifest") || basename(src).toLowerCase() === "manifest.json";

    if (isMinifyCss && isCss) {
      const minifyFn = isMinifyCss === true ? minifyCss : isMinifyCss;
      const css = rewriteCssBasePaths((await readFile(src)).toString(), BascikConfig.base);
      let minified: string;
      try {
        minified = await minifyFn(css);
      } catch (minErr) {
        const behavior = BascikConfig.onMinifyError ?? "error";
        if (behavior === "error") {
          console.error(`[bascik] CSS minification failed for ${src}:`, minErr);
          throw minErr;
        }
        console.warn(`[bascik] CSS minification failed for ${src}, falling back to unminified copy:`, minErr);
        minified = css;
      }
      await writeIfChanged(minified, true);
      return;
    } else if (BascikConfig.base !== "/" && (isCss || isWebManifest)) {
      const source = (await readFile(src)).toString();
      const transformed = isCss
        ? rewriteCssBasePaths(source, BascikConfig.base)
        : rewriteManifestBasePaths(source, BascikConfig.base);
      await writeIfChanged(transformed, false);
      return;
    } else if (minifyJsCfg && src.endsWith(".js")) {
      const minifyFn = minifyJsCfg === true ? minifyJs : minifyJsCfg;
      let minified: string;
      try {
        minified = await minifyFn((await readFile(src)).toString());
      } catch (minErr) {
        const behavior = BascikConfig.onMinifyError ?? "error";
        if (behavior === "error") {
          console.error(`[bascik] JS minification failed for ${src}:`, minErr);
          throw minErr;
        }
        console.warn(`[bascik] JS minification failed for ${src}, falling back to unminified copy:`, minErr);
        minified = (await readFile(src)).toString();
      }
      await writeIfChanged(minified, true);
      return;
    }

    const [srcHash, destHash] = await Promise.all([
      calculateFileHash(src),
      // The dest file might not exist, so return null
      calculateFileHash(destPath).catch(() => null),
    ]);
    await manifestCollector.recordFileFromDisk(src);
    if (srcHash === destHash) return;
    await copyFile(src, destPath);
    if (canLogDevEvent(BascikConfig.logging?.copies, "info")) {
      console.log("copied:", displayRelativePath(src));
    }
  } catch (err) {
    console.error("Failed to copy file:", src, err);
    throw err;
  }
}

export const listPages = async () => {
  return deepReadDirFlat(BascikConfig.directory.pages, /\.html$/);
};

type NestedPaths = (string | NestedPaths)[];

const flattenPaths = (items: NestedPaths): string[] => {
  const result: string[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      result.push(...flattenPaths(item));
    } else {
      result.push(item);
    }
  }
  return result;
};

/** realpath that never throws; falls back to the input when the fs cannot answer. */
const safeRealpath = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
};

/**
 * Recursive directory read that follows symlinks.
 *
 * Symlink policy (prompt 80): a symlinked directory is recursed and a
 * symlinked file is included, both under their LINK path so results stay
 * under the configured root. A per-traversal set of visited realpaths makes
 * cycles (`root/loop -> root`) terminate with one warning naming the link. A
 * dangling link (target missing) is skipped with one warning. Real entries at
 * each level are processed before symlinks so that when a link aliases a
 * sibling directory the real directory always wins.
 *
 * Originally adapted from https://stackoverflow.com/a/71166133/1469690
 */
const deepReadDir = async (
  dirPath: string,
  isRoot = true,
  visited: Set<string> = new Set(),
): Promise<NestedPaths> => {
  try {
    if (isRoot) visited.add(await safeRealpath(dirPath));
    // withFileTypes is what makes it return dirent
    const dirents = await readdir(dirPath, { withFileTypes: true });
    // Sort directory entries byte-wise at each level for deterministic traversal
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const isLink = (dirent: Dirent): boolean =>
      typeof dirent.isSymbolicLink === "function" && dirent.isSymbolicLink();
    const realEntries = dirents.filter((dirent) => !isLink(dirent));
    const linkEntries = dirents.filter(isLink);

    const realResults = await Promise.all(
      realEntries.map(async (dirent: Dirent) => {
        const path = join(dirPath, dirent.name);
        if (!dirent.isDirectory()) return path;
        visited.add(await safeRealpath(path));
        return deepReadDir(path, false, visited);
      }),
    );

    const linkResults: NestedPaths = [];
    for (const dirent of linkEntries) {
      const path = join(dirPath, dirent.name);
      let target: Awaited<ReturnType<typeof stat>>;
      try {
        target = await stat(path);
      } catch {
        console.warn("[bascik] warning: skipping dangling symlink %s (target does not exist)", path);
        continue;
      }
      if (!target.isDirectory()) {
        linkResults.push(path);
        continue;
      }
      const real = await safeRealpath(path);
      if (visited.has(real)) {
        console.warn(
          "[bascik] warning: symlink cycle: %s points at %s, which is already being scanned; skipping",
          path,
          real,
        );
        continue;
      }
      visited.add(real);
      linkResults.push(await deepReadDir(path, false, visited));
    }

    return [...realResults, ...linkResults];
  } catch (error) {
    if (isRoot) throw error;
    console.warn("Failed to read subdirectory %s", dirPath, error);
    return [];
  }
};

/**
 *
 * @param {String} dirPath
 * @param {RegExp} filter
 * @returns
 */
export const deepReadDirFlat = async (
  dirPath: string,
  filter?: RegExp,
): Promise<string[]> => {
  const files = flattenPaths(await deepReadDir(dirPath));
  if (!filter) return files;
  return files.filter((filePath) => `${filePath}`.match(filter));
};

export const copyStaticAssets = async (): Promise<void> => {
  const pagesRoot = BascikConfig.directory.pages;
  const allPageFiles = await deepReadDirFlat(pagesRoot);
  const pageAssetFiles = allPageFiles.filter((filePath) =>
    isStaticAssetPath(filePath, pagesRoot, true));

  await Promise.all(
    pageAssetFiles.map((filePath) => copyReplicatePath(filePath, BascikConfig.directory.out)),
  );
};

export const getDirectoryPath = (pagePath: string): string => {
  const normalized = pagePath.replace(/\\/g, "/");
  return normalized.split("/").slice(1, -1).join("/");
};

export const getDistPagePath = (pagePath: string): string => {
  const outDirRel = (BascikConfig.directory.out ? relative(process.cwd(), BascikConfig.directory.out) : "") || "dist";
  const normalized = pagePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const relativePagePath = normalized.replace(/^pages\//, "");
  return `${outDirRel}/${relativePagePath}`;
};

/**
 * Resolve a source path (absolute or `pages/…`-relative) to its `dist/…`
 * counterpart.  Centralized so every caller — page removal, asset unlink,
 * asset unlinkDir — resolves the same way regardless of whether the watcher
 * handed us an absolute or relative path.
 */
export const toDistPath = (srcPath: string): string => {
  const outDirRel = (BascikConfig.directory.out ? relative(process.cwd(), BascikConfig.directory.out) : "") || "dist";
  const outputRoot = resolve(BascikConfig.directory.out);
  const normalizedOutputRoot = outputRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedSrc = srcPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  let targetPath = "";
  if (normalizedSrc.startsWith(`${outDirRel}/`)) {
    targetPath = normalizedSrc;
  } else if (normalizedSrc.startsWith(`${normalizedOutputRoot}/`)) {
    targetPath = `${outDirRel}/${normalizedSrc.slice(normalizedOutputRoot.length + 1)}`;
  } else {
    const sourceSegments = normalizedSrc.split("/");
    const configuredPagesDir = BascikConfig.directory.pages.replace(/\\/g, "/").replace(/\/+$/, "");
    const hasConfiguredRoot = (configuredDir: string): boolean => {
      const root = configuredDir.replace(/^\/+|\/+$/g, "");
      return normalizedSrc.replace(/^\/+/, "").startsWith(`${root}/`) || normalizedSrc.includes(`/${root}/`);
    };
    const hasSourceRoot =
      normalizedSrc.startsWith("pages/") ||
      normalizedSrc.startsWith("components/") ||
      hasConfiguredRoot(configuredPagesDir) ||
      findComponentRoot(normalizedSrc) !== undefined ||
      getComponentRoots().some((root) => hasConfiguredRoot(root));
    const isAbsoluteSource = normalizedSrc.startsWith("/") || /^[A-Za-z]:\//.test(normalizedSrc);
    if (
      sourceSegments.includes("..") ||
      !normalizedSrc.includes("/") ||
      (isAbsoluteSource && !hasSourceRoot)
    ) {
      throw new OutputPathError(srcPath);
    }
    const rel = getRelativePath(srcPath, "pages");
    targetPath = rel.replace(/^pages[\/]/, `${outDirRel}/`);
  }

  const resolvedTarget = resolve(targetPath);
  const relativeTarget = relative(outputRoot, resolvedTarget);
  if (!relativeTarget || relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new OutputPathError(srcPath);
  }
  return targetPath;
};

class OutputPathError extends Error {
  constructor(srcPath: string) {
    super(`Refusing path outside the configured output directory: ${srcPath}`);
  }
}

const canLogDevEvent = (
  flag: boolean | undefined,
  level: "info" | "debug" = "info",
) => {
  const configLevel = BascikConfig.logging?.level ?? "info";
  return (flag ?? true) && shouldLog(configLevel, level);
};

export const deleteDistFile = async (pagePath: string): Promise<void> => {
  try {
    const distPagePath = toDistPath(pagePath);
    await rm(distPagePath);
    if (canLogDevEvent(BascikConfig.logging?.deletes, "info")) {
      console.log(`deleted file: ${displayRelativePath(pagePath)}`);
    }
  } catch (error) {
    if (error instanceof OutputPathError) throw error;
    // File doesn't exist, that's ok.
    // Don't check prior, per node.js doc's say not to because race conditions
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error("Error Deleting Dist File", error);
  }
};

export const deleteDistDir = async (dirPath: string): Promise<void> => {
  try {
    const distDirPath = toDistPath(dirPath);
    // recursive means delete directory
    // force means delete the file inside
    await rm(distDirPath, { recursive: true, force: true });
    if (canLogDevEvent(BascikConfig.logging?.deletes, "info")) {
      console.log(`deleted dir: ${displayRelativePath(dirPath)}`);
    }
    await rm(distDirPath, { recursive: true, force: true });
  } catch (error) {
    if (error instanceof OutputPathError) throw error;
    // File doesn't exist, that's ok.
    // Don't check prior, per node.js doc's say not to because race conditions
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    console.error("Error Deleting Dist Directory", error);
  }
};
