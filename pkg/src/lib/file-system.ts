import { readdir, rm, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { BascikConfig, shouldLog } from "./config.js";
import { minifyCss } from "./styles.js";
import { minifyJs } from "./javascript.js";

/** Resolve an absolute path to a `parentDir/...` relative path, normalizing separators. */
export const getRelativePath = (path: string, parentDir: string): string => {
  const normalizedPath = path.replace(/\\/g, "/");
  const parentPath = (parentDir === "pages"
    ? BascikConfig.directory.pages
    : BascikConfig.directory.components
  ).replace(/\\/g, "/");

  if (normalizedPath.startsWith(`${parentDir}/`)) {
    const relative = normalizedPath.slice(parentDir.length + 1).replace(/^\.?\//, "").replace(/^\//, "");
    return relative ? `${parentDir}/${relative}`.replace(/\/+/g, "/") : parentDir;
  }

  const suffix = normalizedPath.includes(`${parentPath}/`)
    ? normalizedPath.split(`${parentPath}/`)[1]
    : normalizedPath.startsWith(`${parentPath}/`)
      ? normalizedPath.slice(parentPath.length + 1)
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

  return normalized.replace(/^\.\//, "").replace(/^\//, "").replace(/^dist\//, "");
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
        if (behavior === "halt" || behavior === "error") {
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
      if (canLogDevEvent(BascikConfig.devServer?.logging?.copies, "info")) {
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
        if (behavior === "halt" || behavior === "error") {
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
      if (canLogDevEvent(BascikConfig.devServer?.logging?.copies, "info")) {
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
    if (canLogDevEvent(BascikConfig.devServer?.logging?.copies, "info")) {
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

export const isInlineStylesheet = (path: string): boolean => {
  if (!BascikConfig.inlineStyles) return false;
  if (!path.endsWith(".css")) return false;
  if (BascikConfig.inlineStyles === true) return true;
  if (Array.isArray(BascikConfig.inlineStyles)) {
    const normalizedPath = path.replace(/\\/g, "/");
    return BascikConfig.inlineStyles.some((stylePath) => {
      const normalizedStyle = stylePath.replace(/\\/g, "/");
      return (
        normalizedPath.endsWith(normalizedStyle) ||
        normalizedStyle.endsWith(normalizedPath)
      );
    });
  }
  return false;
};

export const copyStaticAssets = async (): Promise<void> => {
  const allFiles = await deepReadDirFlat(BascikConfig.directory.pages);
  const staticAssetFiles = allFiles.filter(
    (filePath) =>
      /\.[a-zA-Z0-9]+$/.test(filePath) &&
      !filePath.endsWith(".html") &&
      !filePath.endsWith(".ts") &&
      !/\.(test|spec)\.[a-zA-Z0-9]+$/.test(filePath) &&
      !isInlineStylesheet(filePath),
  );
  await Promise.all(
    staticAssetFiles.map((filePath) => copyReplicatePath(filePath, "dist")),
  );
};

export const getDirectoryPath = (pagePath: string): string => {
  const normalized = pagePath.replace(/\\/g, "/");
  return normalized.split("/").slice(1, -1).join("/");
};

export const getDistPagePath = (pagePath: string): string => {
  const normalized = pagePath.replace(/\\/g, "/");
  const pathParts = normalized.split("/");
  pathParts[0] = "dist";
  return pathParts.join("/");
};

/**
 * Resolve a source path (absolute or `pages/…`-relative) to its `dist/…`
 * counterpart.  Centralized so every caller — page removal, asset unlink,
 * asset unlinkDir — resolves the same way regardless of whether the watcher
 * handed us an absolute or relative path.
 */
export const toDistPath = (srcPath: string): string => {
  const normalizedSrc = srcPath.replace(/\\/g, "/");
  if (normalizedSrc.startsWith("dist/")) return normalizedSrc;
  if (normalizedSrc.includes("/dist/")) {
    return `dist/${normalizedSrc.split("/dist/")[1]}`;
  }
  const rel = getRelativePath(srcPath, "pages");
  return rel.replace(/^pages[\/]/, "dist/");
};

const canLogDevEvent = (
  flag: boolean | undefined,
  level: "info" | "debug" = "info",
) => {
  const configLevel = BascikConfig.devServer?.logging?.level ?? "info";
  return (flag ?? true) && shouldLog(configLevel, level);
};

export const deleteDistFile = async (pagePath: string): Promise<void> => {
  try {
    const distPagePath = toDistPath(pagePath);
    await rm(distPagePath);
    if (canLogDevEvent(BascikConfig.devServer?.logging?.deletes, "info")) {
      console.log(`deleted file: ${displayRelativePath(pagePath)}`);
    }
  } catch (error) {
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
    if (canLogDevEvent(BascikConfig.devServer?.logging?.deletes, "info")) {
      console.log(`deleted dir: ${displayRelativePath(dirPath)}`);
    }
  } catch (error) {
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
