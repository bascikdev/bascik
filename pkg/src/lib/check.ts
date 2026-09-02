/**
 * @module check
 *
 * Static analysis for Bascik projects (`bascik --check`).
 *
 * Scans all pages and component files for:
 *  - Hyphenated tags that have no matching component file (errors)
 *  - Component files that are never referenced anywhere (warnings)
 *
 * Exits with code 1 when errors are found so it can gate CI pipelines.
 *
 * Build-script usage
 * ──────────────────
 * `<script data-bascik-build>` blocks can generate component usage at build
 * time.  Running arbitrary build scripts during `--check` would be unsafe and
 * slow, so instead a file that contains any build script is treated as
 * *potentially generating* any component: its build-script presence marks
 * every known component as "used" (unused is a warning, not an error, so this
 * only suppresses false-positive warnings).  Unknown-tag *errors* are still
 * reported for the file's static markup.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { listPages, getRelativePath } from "./file-system.ts";
import { listComponents } from "./components.ts";
import { BascikConfig } from "./config.ts";
import { maskElementContents } from "./shielding.ts";
import { scanApiRouteFiles, fileToApiRoutePath } from "./api-routes.ts";
import type { ComponentList } from "./types.ts";

const VALID_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const API_METHOD_LIKE_REGEX = /\bexport\s+(?:async\s+)?(?:const|function|let|var)\s+([a-zA-Z0-9_$]+)\b/g;

/**
 * Strip the inner content of elements that can legitimately contain raw,
 * non-markup text — `script`, `style`, `textarea`, plus whatever the user
 * configured in `skipTranspilingElementContents` (defaults to `["code"]`).
 *
 * Without this, literal example text inside such elements (e.g. `<my-tag>`
 * inside a `<script>` demo string) produces false-positive "unknown component"
 * errors.
 */
const stripElementContents = (html: string): string => {
  const extra = (BascikConfig.scoping?.preserve ?? [])
    .map((t) => String(t).replace(/[^a-zA-Z0-9-]/g, ""))
    .filter(Boolean);
  const protectedTags = ["script", "style", "textarea", ...extra];
  return maskElementContents(html, protectedTags);
};

/**
 * Extract all hyphenated tag names from an HTML string.
 * HTML comments and the inner content of raw-text elements (script, style,
 * textarea, and `skipTranspilingElementContents`) are stripped first to avoid
 * false positives.
 */
export const extractCustomTags = (html: string): Set<string> => {
  // Strip HTML comments so we don't match tags inside <!-- ... -->
  const stripped = stripElementContents(html.replace(/<!--[\s\S]*?-->/g, ""));
  const tags = new Set<string>();
  const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    tags.add(m[1].toLowerCase());
  }
  return tags;
};

/** Return a human-readable relative path for a file. */
const toDisplay = (filePath: string): string => {
  try {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.includes(BascikConfig.directory.pages.replace(/\\/g, "/"))) {
      return getRelativePath(filePath, "pages");
    }
    if (normalized.includes(BascikConfig.directory.components.replace(/\\/g, "/"))) {
      return getRelativePath(filePath, "components");
    }
  } catch {
    // fall through
  }
  return filePath;
};

/**
 * Quick static check for `<script data-bascik-build>` presence.
 * Quote-aware enough for detection purposes: looks for the flag as an actual
 * attribute name on a `<script>` open tag.
 */
const containsBuildScript = (html: string): boolean =>
  /<script\b(?:[^\s"'=<>`]+|"[^"]*"|'[^']*')*\sdata-bascik-build\b/i.test(html);

/**
 * Run the static check and print results to stdout/stderr.
 *
 * @returns `true` when no errors were found (warnings are still printed).
 *          Unused components are warnings only and do not affect the return value.
 */
export const checkProject = async (): Promise<boolean> => {
  const [pages, componentList] = await Promise.all([
    listPages(),
    listComponents() as Promise<ComponentList>,
  ]);

  const pageList = pages ?? [];
  const knownComponents = new Set(Object.keys(componentList));

  // Absolute paths to every component HTML file
  const componentFilePaths: string[] = Object.values(componentList)
    .map((c) => c.fileName)
    .filter((f): f is string => Boolean(f));

  // Scan every page AND every component source file for hyphenated tags
  const allFilePaths = [...pageList, ...componentFilePaths];

  const scanResults = await Promise.all(
    allFilePaths.map(async (filePath) => {
      try {
        const html = await readFile(filePath, "utf8");
        return {
          filePath,
          tags: extractCustomTags(html),
          hasBuildScript: containsBuildScript(html),
        };
      } catch {
        return { filePath, tags: new Set<string>(), hasBuildScript: false };
      }
    }),
  );

  let hasErrors = false;
  const usedComponents = new Set<string>();

  // Build scripts can generate component usage at build time.  We never run
  // build scripts during `--check` (arbitrary code execution), so a file that
  // contains one conservatively marks every known component as "used" — this
  // only suppresses false-positive *unused warnings*, never errors.
  if (scanResults.some((r) => r.hasBuildScript)) {
    for (const c of knownComponents) usedComponents.add(c);
  }

  for (const { filePath, tags } of scanResults) {
    const unknown: string[] = [];
    for (const tag of tags) {
      if (knownComponents.has(tag)) {
        usedComponents.add(tag);
      } else {
        unknown.push(tag);
      }
    }
    if (unknown.length > 0) {
      console.error(
        `[bascik check] Unknown component${unknown.length > 1 ? "s" : ""} in "${toDisplay(filePath)}": ` +
        `${unknown.map((t) => `<${t}>`).join(", ")} — no matching component file found`,
      );
      hasErrors = true;
    }
  }

  // ── API route static analysis (Prompt 49) ───────────────────────────
  const apiDir = resolve(process.cwd(), BascikConfig.directory?.api ?? "src/api");
  if (existsSync(apiDir)) {
    const apiFiles = await scanApiRouteFiles(apiDir);
    const routesByUrl = new Map<string, string[]>();

    for (const filePath of apiFiles) {
      const normalizedApiDir = apiDir.replace(/\\/g, "/");
      const normalizedFilePath = filePath.replace(/\\/g, "/");
      let rel = normalizedFilePath.startsWith(normalizedApiDir + "/")
        ? normalizedFilePath.slice(normalizedApiDir.length + 1)
        : filePath;
      const routeUrl = fileToApiRoutePath(rel, BascikConfig.base ?? "/");

      const existing = routesByUrl.get(routeUrl);
      if (existing) {
        existing.push(filePath);
      } else {
        routesByUrl.set(routeUrl, [filePath]);
      }

      try {
        const content = await readFile(filePath, "utf8");
        API_METHOD_LIKE_REGEX.lastIndex = 0;
        const exportedNames: string[] = [];
        let match: RegExpExecArray | null;

        while ((match = API_METHOD_LIKE_REGEX.exec(content)) !== null) {
          const name = match[1];
          exportedNames.push(name);

          const upper = name.toUpperCase();
          if (VALID_API_METHODS.has(upper) && name !== upper) {
            console.warn(
              `[bascik check] Warning in "${filePath}": method export "${name}" must be uppercase ("${upper}"). Lowercase or mixed-case HTTP methods are not recognized by the dispatcher.`
            );
          }
        }

        const hasRecognized = exportedNames.some((n) => VALID_API_METHODS.has(n));
        if (!hasRecognized) {
          console.error(
            `[bascik check] Error in "${filePath}": file exports no recognized HTTP method handler (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD).`
          );
          hasErrors = true;
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Check for collisions
    for (const [url, filePaths] of routesByUrl.entries()) {
      if (filePaths.length > 1) {
        console.error(
          `[bascik check] Route URL Collision: "${url}" is declared in multiple route files:\n` +
          filePaths.map((f) => `  - ${f}`).join("\n")
        );
        hasErrors = true;
      }
    }
  }

  // Unused components are warnings, not errors — they don't break builds
  const unused = [...knownComponents].filter((c) => !usedComponents.has(c));
  if (unused.length > 0) {
    console.warn(
      `[bascik check] Unused component${unused.length > 1 ? "s" : ""}: ` +
      `${unused.map((c) => `<${c}>`).join(", ")} — defined but never referenced`,
    );
  }

  if (!hasErrors) {
    const warnNote = unused.length > 0 ? ` (${unused.length} unused)` : "";
    console.log(
      `[bascik check] ✓ ${pageList.length} page${pageList.length !== 1 ? "s" : ""} ` +
      `and ${knownComponents.size} component${knownComponents.size !== 1 ? "s" : ""} checked — no errors${warnNote}`,
    );
  }

  return !hasErrors;
};
