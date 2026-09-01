import { readdir, rm, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { BascikConfig, shouldLog } from "./config.ts";
import { minifyCss } from "./styles.ts";
import { minifyJs } from "./javascript.ts";
import { isInlineStylesheet, isStaticAssetPath } from "./asset-filter.ts";

export { isInlineStylesheet, isStaticAssetPath } from "./asset-filter.ts";

/** Resolve an absolute path to a `parentDir/...` relative path, normalizing separators. */
export const getRelativePath = (path: string, parentDir: "pages" | "components"): string => {
  const normalizedPath = path.replace(/\\/g, "/");
  const configuredDir = (parentDir === "pages"
    ? BascikConfig.directory.pages
    : BascikConfig.directory.components
  ).replace(/\\/g, "/");

  if (normalizedPath === parentDir || normalizedPath === configuredDir) {
    return parentDir;
  }

  if (normalizedPath.startsWith(`${parentDir}/`)) {
    const relative = normalizedPath.slice(parentDir.length + 1).replace(/^\.?\//, "").replace(/^\//, "");
    return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
  }

  const configuredDirMarker = `${configuredDir}/`;
  const markerIndex = normalizedPath.lastIndexOf(configuredDirMarker);
  const suffix = markerIndex >= 0
    ? normalizedPath.slice(markerIndex + configuredDirMarker.length)
    : normalizedPath;

  const relative = (suffix ?? "").replace(/^\.?\//, "").replace(/^\//, "");
  return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
};

const displayRelativePath = (path: string): string => {
  const normalized = path.replace(/\\/g, "/");
  const pagesDir = BascikConfig.directory.pages.replace(/\\/g, "/");
  const componentsDir = BascikConfig.directory.components.replace(/\\/g, "/");

  if (normalized.includes(`/${pagesDir}/`)) {
    return `pages/${normalized.split(`/${pagesDir}/`)[1]}`;
  }
  if (normalized.startsWith(`${pagesDir}/`)) {
    return normalized;
  }
  if (normalized.includes(`/${componentsDir}/`)) {
    return `components/${normalized.split(`/${componentsDir}/`)[1]}`;
  }
  if (normalized.startsWith(`${componentsDir}/`)) {
    return normalized;
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

  // Only copy if file hashes differ
  try {
    const isMinifyCss = BascikConfig.minify?.css ?? false;
    const minifyJsCfg = BascikConfig.minify?.js ?? false;

    if (isMinifyCss && src.endsWith(".css")) {
      const minifyFn = isMinifyCss === true ? minifyCss : isMinifyCss;
      let minified: string;
      try {
        minified = await minifyFn((await readFile(src)).toString());
      } catch (minErr) {
        const behavior = BascikConfig.onMinifyError ?? "error";
        if (behavior === "error") {
          console.error(`[bascik] CSS minification failed for ${src}:`, minErr);
          throw minErr;
        }
        console.warn(`[bascik] CSS minification failed for ${src}, falling back to unminified copy:`, minErr);
        minified = (await readFile(src)).toString();
      }
      const destHash = createHash("sha256").update(await readFile(destPath).catch(() => "")).digest("hex");
      const minifiedHash = createHash("sha256").update(minified).digest("hex");
      if (minifiedHash === destHash) return;
      await writeFile(destPath, minified);
      if (canLogDevEvent(BascikConfig.logging?.copies, "info")) {
        console.log("copied (minified):", displayRelativePath(src));
      }
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
      const destHash = createHash("sha256").update(await readFile(destPath).catch(() => "")).digest("hex");
      const minifiedHash = createHash("sha256").update(minified).digest("hex");
      if (minifiedHash === destHash) return;
      await writeFile(destPath, minified);
      if (canLogDevEvent(BascikConfig.logging?.copies, "info")) {
        console.log("copied (minified):", displayRelativePath(src));
      }
      return;
    }

    const [srcHash, destHash] = await Promise.all([
      calculateFileHash(src),
      // The dest file might not exist, so return null
      calculateFileHash(destPath).catch(() => null),
    ]);
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

// Taken from https://stackoverflow.com/a/71166133/1469690
// Returns any[] because the recursive structure cannot be expressed as a fixed-depth generic.
export const deepReadDir = async (dirPath: string): Promise<any[]> => {
  try {
    // withFileTypes is what makes it return dirent
    const dirents = await readdir(dirPath, { withFileTypes: true });
    return Promise.all(
      dirents.map(async (dirent: Dirent) => {
        const path = join(dirPath, dirent.name);
        return dirent.isDirectory() ? await deepReadDir(path) : path;
      }),
    );
  } catch (error) {
    console.error("Failed to read directory %s", dirPath, error);
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
  try {
    const files = (await deepReadDir(dirPath)).flat(
      Number.POSITIVE_INFINITY,
    ) as string[];
    if (!filter) return files;
    return files.filter((filePath) => `${filePath}`.match(filter));
  } catch (error) {
    console.error("Error Reading Directory", error);
    return [];
  }
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
  const normalizedSrc = srcPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  let targetPath = "";
  if (normalizedSrc.startsWith(`${outDirRel}/`)) targetPath = normalizedSrc;
  if (normalizedSrc.includes(`/${outDirRel}/`)) {
    targetPath = `${outDirRel}/${normalizedSrc.slice(normalizedSrc.lastIndexOf(`/${outDirRel}/`) + outDirRel.length + 2)}`;
  } else if (!targetPath) {
    const sourceSegments = normalizedSrc.split("/");
    const configuredPagesDir = BascikConfig.directory.pages.replace(/\\/g, "/").replace(/\/+$/, "");
    const configuredComponentsDir = BascikConfig.directory.components.replace(/\\/g, "/").replace(/\/+$/, "");
    const hasConfiguredRoot = (configuredDir: string): boolean => {
      const root = configuredDir.replace(/^\/+|\/+$/g, "");
      return normalizedSrc.replace(/^\/+/, "").startsWith(`${root}/`) || normalizedSrc.includes(`/${root}/`);
    };
    const hasSourceRoot =
      normalizedSrc.startsWith("pages/") ||
      normalizedSrc.startsWith("components/") ||
      hasConfiguredRoot(configuredPagesDir) ||
      hasConfiguredRoot(configuredComponentsDir);
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

  const outputRoot = resolve(BascikConfig.directory.out);
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

export const createDir = async (path: string): Promise<void> => {
  try {
    await mkdir(path, { recursive: true });
  } catch (error) {
    console.error("Error Creating Dist Directory", error);
  }
};
