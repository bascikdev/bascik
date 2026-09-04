/**
 * @module add
 *
 * Implements the `bascik add` CLI command.
 *
 * Follows a shadcn-style copy-in model:
 * Components are copied from an installed npm package's advertised directory
 * (via a `bascik.components` field in the package's package.json) into the
 * project's local components directory.
 *
 * Copied files belong to the project, are committed, and are not resolved
 * from node_modules at build time.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { BascikConfig } from "./config.ts";
import { deepReadDirFlat } from "./file-system.ts";
import { deriveComponentName } from "./components.ts";

export interface AddOptions {
  cwd?: string;
  componentsDir?: string;
  force?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  isTTY?: boolean;
}

export interface CopiedFileInfo {
  srcPath: string;
  destPath: string;
  content: string;
  hash: string;
  componentTag?: string;
}

export interface LockfileComponentFile {
  hash: string;
}

export interface LockfilePackageEntry {
  version: string;
  files: Record<string, LockfileComponentFile>;
}

export interface BascikLockfile {
  $schema?: string;
  components: Record<string, LockfilePackageEntry>;
}

export interface AddResult {
  copiedFiles: CopiedFileInfo[];
  /**
   * Absolute directory the files were (or would be) copied into. With several
   * `directory.components` roots this is the first listed one, so the CLI can
   * tell the user where the files landed.
   */
  targetComponentsDir: string;
}

const LOCKFILE_NAME = "bascik-lock.json";

/**
 * Computes sha256 hash for string content.
 */
export const computeContentHash = (content: string): string => {
  return createHash("sha256").update(content).digest("hex");
};

/**
 * Resolves the location of an installed npm package.
 */
export const resolvePackageDir = (packageName: string, cwd: string): string => {
  // Check in <cwd>/node_modules/<packageName>
  const directPath = join(cwd, "node_modules", ...packageName.split("/"));
  if (existsSync(directPath)) {
    return directPath;
  }

  // Also try node import.meta.resolve lookup if available
  try {
    const pkgJsonPath = import.meta.resolve(
      `${packageName}/package.json`,
      `file://${resolve(cwd)}/`,
    );
    if (pkgJsonPath && pkgJsonPath.startsWith("file://")) {
      return dirname(pkgJsonPath.replace(/^file:\/\//, ""));
    }
  } catch {
    // ignore
  }

  throw new Error(
    `Package "${packageName}" is not installed. Please install it first with your package manager (e.g. npm install ${packageName} or yarn add ${packageName}).`,
  );
};

/**
 * Parses an add target string into package name and optional component selector.
 * e.g. "@acme/ui" -> { packageName: "@acme/ui", componentSelector: undefined }
 * e.g. "@acme/ui/card" -> { packageName: "@acme/ui", componentSelector: "card" }
 * e.g. "ui-kit/button" -> { packageName: "ui-kit", componentSelector: "button" }
 * e.g. "ui-kit" -> { packageName: "ui-kit", componentSelector: undefined }
 */
export const parseAddTarget = (
  target: string,
): { packageName: string; componentSelector?: string } => {
  if (target.startsWith("@")) {
    const parts = target.split("/");
    if (parts.length <= 2) {
      return { packageName: target };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const componentSelector = parts.slice(2).join("/");
    return { packageName, componentSelector };
  } else {
    const parts = target.split("/");
    if (parts.length <= 1) {
      return { packageName: target };
    }
    const packageName = parts[0];
    const componentSelector = parts.slice(1).join("/");
    return { packageName, componentSelector };
  }
};

/**
 * Reads and validates the package.json of a component package.
 */
export const readPackageManifest = async (
  pkgDir: string,
  packageName: string,
): Promise<{ version: string; componentsDir: string }> => {
  const pkgJsonPath = join(pkgDir, "package.json");
  let raw: string;
  try {
    raw = await readFile(pkgJsonPath, "utf8");
  } catch {
    throw new Error(
      `Package "${packageName}" is missing a package.json file at ${pkgJsonPath}.`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Failed to parse package.json for package "${packageName}".`,
    );
  }

  const version = typeof parsed.version === "string" ? parsed.version : "0.0.0";
  const bascik = parsed.bascik;

  if (
    !bascik ||
    typeof bascik !== "object" ||
    Array.isArray(bascik) ||
    !("components" in bascik)
  ) {
    throw new Error(
      `package "${packageName}" is missing a "bascik.components" field in its package.json.\n` +
      `  To publish Bascik components, add a "bascik" field to package.json pointing to your components directory:\n` +
      `  {\n` +
      `    "bascik": {\n` +
      `      "components": "./components"\n` +
      `    }\n` +
      `  }`,
    );
  }

  const componentsVal = (bascik as Record<string, unknown>).components;
  if (typeof componentsVal !== "string" || !componentsVal.trim()) {
    throw new Error(
      `"bascik.components" field in "${packageName}" must be a string pointing to the components directory (e.g. "./components").`,
    );
  }

  const componentsDir = resolve(pkgDir, componentsVal);
  assertPathInside(componentsDir, pkgDir);
  return { version, componentsDir };
};

/**
 * Verifies that a target file path stays inside the target directory.
 */
export const assertPathInside = (filePath: string, parentDir: string): void => {
  const resolvedParent = resolve(parentDir);
  const resolvedFile = resolve(filePath);
  const rel = relative(resolvedParent, resolvedFile);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path traversal detected: "${filePath}" is outside the directory "${parentDir}".`,
    );
  }
};

/**
 * Loads the existing bascik-lock.json if present.
 */
export const loadLockfile = async (cwd: string): Promise<BascikLockfile> => {
  const lockfilePath = join(cwd, LOCKFILE_NAME);
  try {
    const raw = await readFile(lockfilePath, "utf8");
    return JSON.parse(raw) as BascikLockfile;
  } catch {
    return { components: {} };
  }
};

/**
 * Saves the bascik-lock.json.
 */
export const saveLockfile = async (
  cwd: string,
  lockfile: BascikLockfile,
): Promise<void> => {
  const lockfilePath = join(cwd, LOCKFILE_NAME);
  await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
};

/**
 * Core implementation of `bascik add`.
 */
export const addComponents = async (
  targets: string[],
  options: AddOptions = {},
): Promise<AddResult> => {
  const cwd = options.cwd ?? process.cwd();
  // `bascik add` targets the FIRST configured root; order is otherwise
  // documentation-only because duplicates across roots are build errors.
  const configuredComponentsDir = options.componentsDir ??
    (options.cwd
      ? join(options.cwd, "src", "components")
      : (BascikConfig.directory?.components?.[0] ?? "src/components"));
  const targetComponentsDir = isAbsolute(configuredComponentsDir)
    ? configuredComponentsDir
    : resolve(cwd, configuredComponentsDir);

  await mkdir(targetComponentsDir, { recursive: true });

  const lockfile = await loadLockfile(cwd);
  if (!lockfile.components) {
    lockfile.components = {};
  }

  // Find all existing local component files to build the existing tag collision map
  const localComponentFiles = existsSync(targetComponentsDir)
    ? (await deepReadDirFlat(
      targetComponentsDir,
      /\.(html|css|js|ts|mjs)$/,
    ).catch(() => [])) ?? []
    : [];

  const existingLocalHtmlFiles = (localComponentFiles as string[]).filter(
    (fileName) => fileName.match(/\.html$/) && !fileName.match(/\.(test|spec)\.html$/),
  );

  const existingTagToFilePath = new Map<string, string>();
  for (const fileName of existingLocalHtmlFiles) {
    const tag = deriveComponentName(fileName);
    existingTagToFilePath.set(tag, fileName);
  }

  const allFilesToCopy: Array<{
    srcPath: string;
    destPath: string;
    relFromCompDir: string;
    content: string;
    hash: string;
    packageName: string;
    packageVersion: string;
    isHtml: boolean;
    derivedTag?: string;
  }> = [];

  for (const target of targets) {
    const { packageName, componentSelector } = parseAddTarget(target);
    const pkgDir = resolvePackageDir(packageName, cwd);
    const { version, componentsDir: pkgComponentsDir } = await readPackageManifest(
      pkgDir,
      packageName,
    );

    // List all component files in the package's advertised components directory
    const packageFiles = (await deepReadDirFlat(
      pkgComponentsDir,
      /\.(html|css|js|ts|mjs)$/,
    )) ?? [];

    if (packageFiles.length === 0) {
      throw new Error(
        `No component files found in "${pkgComponentsDir}" for package "${packageName}".`,
      );
    }

    // Filter by componentSelector if provided
    let candidateFiles = packageFiles as string[];
    if (componentSelector) {
      const normalizedSelector = componentSelector.toLowerCase();
      candidateFiles = candidateFiles.filter((filePath) => {
        const rel = relative(pkgComponentsDir, filePath).replace(/\\/g, "/");
        const normalizedRel = rel.toLowerCase();
        const derived = deriveComponentName(filePath);
        return (
          derived === normalizedSelector ||
          normalizedRel === normalizedSelector ||
          normalizedRel.startsWith(`${normalizedSelector}.`) ||
          normalizedRel.startsWith(`${normalizedSelector}/`)
        );
      });

      if (candidateFiles.length === 0) {
        throw new Error(
          `Component "${componentSelector}" not found in package "${packageName}".`,
        );
      }
    }

    for (const srcFilePath of candidateFiles) {
      const relFromCompDir = relative(pkgComponentsDir, srcFilePath);
      const destFilePath = resolve(targetComponentsDir, relFromCompDir);

      // Verify path safety
      assertPathInside(destFilePath, targetComponentsDir);

      const content = await readFile(srcFilePath, "utf8");
      const hash = computeContentHash(content);
      const isHtml = Boolean(
        srcFilePath.match(/\.html$/) && !srcFilePath.match(/\.(test|spec)\.html$/),
      );
      const derivedTag = isHtml ? deriveComponentName(srcFilePath) : undefined;

      allFilesToCopy.push({
        srcPath: srcFilePath,
        destPath: destFilePath,
        relFromCompDir,
        content,
        hash,
        packageName,
        packageVersion: version,
        isHtml,
        derivedTag,
      });
    }
  }

  // Check 1: Destination path collisions across multiple targets/files in the batch
  const destPathToSrcMap = new Map<string, string>();
  for (const item of allFilesToCopy) {
    if (destPathToSrcMap.has(item.destPath)) {
      const existingSrc = destPathToSrcMap.get(item.destPath)!;
      throw new Error(
        `error: destination file collision for "${item.destPath}"\n` +
        `  source 1: ${existingSrc}\n` +
        `  source 2: ${item.srcPath}\n` +
        `  Multiple add targets resolve to the same destination path. Refusing to overwrite.`,
      );
    }
    destPathToSrcMap.set(item.destPath, item.srcPath);
  }

  // Check 2: Collision check against existing project components and within the batch
  const batchTagToFilePath = new Map<string, string>();

  for (const item of allFilesToCopy) {
    if (item.isHtml && item.derivedTag) {
      const tag = item.derivedTag;

      // Check against other items in the batch
      if (batchTagToFilePath.has(tag)) {
        const existingSrc = batchTagToFilePath.get(tag)!;
        throw new Error(
          `error: component name collision for <${tag}>\n` +
          `  ${existingSrc}\n` +
          `  ${item.srcPath}\n` +
          `  Component names come from the filename, so subfolders do not create separate namespaces.`,
        );
      }
      batchTagToFilePath.set(tag, item.srcPath);

      // Check against existing project files
      if (existingTagToFilePath.has(tag)) {
        const existingLocalPath = existingTagToFilePath.get(tag)!;
        const pkgRecord = lockfile.components[item.packageName];
        const isTrackedUnderThisPkg = Boolean(pkgRecord?.files?.[item.relFromCompDir]);
        const existingRel = relative(targetComponentsDir, existingLocalPath).replace(/\\/g, "/");
        const destRel = relative(targetComponentsDir, item.destPath).replace(/\\/g, "/");

        // If it was not previously added from this package, or if the relative path in components dir differs:
        // it is a collision with an existing project component!
        if (!isTrackedUnderThisPkg || existingRel !== destRel) {
          throw new Error(
            `error: component name collision for <${tag}>\n` +
            `  existing project component: ${existingLocalPath}\n` +
            `  package component: ${item.srcPath}\n` +
            `  Component names come from the filename, so subfolders do not create separate namespaces. Rename the existing component or adjust the package.`,
          );
        }
      }
    }
  }

  // Check 3: Modification check on existing destination files
  for (const item of allFilesToCopy) {
    if (existsSync(item.destPath)) {
      const currentLocalContent = await readFile(item.destPath, "utf8");
      const currentLocalHash = computeContentHash(currentLocalContent);

      const pkgRecord = lockfile.components[item.packageName];
      const fileRecord = pkgRecord?.files?.[item.relFromCompDir];

      if (fileRecord) {
        // File was previously added via bascik add
        const originalRecordedHash = fileRecord.hash;
        if (currentLocalHash !== originalRecordedHash) {
          // Local file has been modified!
          if (!options.force) {
            throw new Error(
              `Component file "${item.relFromCompDir}" has been modified locally. ` +
              `Refusing to overwrite without --force.\n` +
              `  Run with --force to overwrite local modifications: bascik add --force <package>`,
            );
          }
        }
      } else {
        // File exists on disk but was NOT tracked in lockfile under this package
        if (currentLocalHash !== item.hash && !options.force) {
          throw new Error(
            `Component file "${item.relFromCompDir}" exists and has different content. ` +
            `Refusing to overwrite without --force.\n` +
            `  Run with --force to overwrite: bascik add --force <package>`,
          );
        }
      }
    }
  }

  // If dryRun, return what would happen without writing
  if (options.dryRun) {
    return {
      targetComponentsDir,
      copiedFiles: allFilesToCopy.map((item) => ({
        srcPath: item.srcPath,
        destPath: item.destPath,
        content: item.content,
        hash: item.hash,
        componentTag: item.derivedTag,
      })),
    };
  }

  // Atomic copy execution:
  // Track written files so if an error occurs mid-copy, we can roll back and leave no partial state
  const writtenFiles: string[] = [];
  const originalFileSnapshots = new Map<string, string | null>(); // null if didn't exist

  try {
    for (const item of allFilesToCopy) {
      const destDir = dirname(item.destPath);
      await mkdir(destDir, { recursive: true });

      if (!originalFileSnapshots.has(item.destPath)) {
        if (existsSync(item.destPath)) {
          originalFileSnapshots.set(
            item.destPath,
            await readFile(item.destPath, "utf8"),
          );
        } else {
          originalFileSnapshots.set(item.destPath, null);
        }
      }

      await writeFile(item.destPath, item.content, "utf8");
      writtenFiles.push(item.destPath);

      // Update lockfile state in-memory
      if (!lockfile.components[item.packageName]) {
        lockfile.components[item.packageName] = {
          version: item.packageVersion,
          files: {},
        };
      }
      lockfile.components[item.packageName].version = item.packageVersion;
      lockfile.components[item.packageName].files[item.relFromCompDir] = {
        hash: item.hash,
      };
    }

    // Save lockfile
    await saveLockfile(cwd, lockfile);
  } catch (err) {
    // Rollback: restore all files to original state
    for (const [filePath, originalContent] of originalFileSnapshots.entries()) {
      if (originalContent === null) {
        await rm(filePath, { force: true }).catch(() => { });
      } else {
        await writeFile(filePath, originalContent, "utf8").catch(() => { });
      }
    }
    throw err;
  }

  return {
    targetComponentsDir,
    copiedFiles: allFilesToCopy.map((item) => ({
      srcPath: item.srcPath,
      destPath: item.destPath,
      content: item.content,
      hash: item.hash,
      componentTag: item.derivedTag,
    })),
  };
};
