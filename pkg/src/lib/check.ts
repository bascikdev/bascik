/**
 * @module check
 *
 * Static analysis for Bascik projects (`bascik --check`).
 *
 * Scans all pages, component files, and API route files for:
 *  - Hyphenated tags that have no matching component file (warnings)
 *  - Component files that are never referenced anywhere (warnings)
 *  - API route method handler and collision issues (errors / warnings)
 *
 * Returns a structured data model of findings. Output formatting is separated
 * into human and JSON formatters.
 */

import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { existsSync } from "node:fs";
import { listPages, getRelativePath } from "./file-system.ts";
import { listComponents } from "./components.ts";
import { BascikConfig } from "./config.ts";
import { maskElementContents } from "./shielding.ts";
import { scanApiRouteFiles, fileToApiRoutePath } from "./api-routes.ts";
import type { ComponentList } from "./types.ts";

export type FindingSeverity = "error" | "warning";

export interface FindingLocation {
  filePath: string;
  line?: number;
}

export interface CheckFinding {
  category: string;
  severity: FindingSeverity;
  message: string;
  locations: FindingLocation[];
  suggestion?: string;
}

export interface CheckFindings {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  items: CheckFinding[];
}

const VALID_API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]);
const API_METHOD_LIKE_REGEX = /\bexport\s+(?:async\s+)?(?:const|function|let|var)\s+([a-zA-Z0-9_$]+)\b/g;

/** Simple edit distance (Levenshtein) with no external dependencies. */
const editDistance = (a: string, b: string): number => {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  const curr: number[] = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
};

/** Suggest closest component name if within edit distance <= 2. */
export const suggestComponentName = (tag: string, knownComponents: Iterable<string>): string | undefined => {
  const normTag = tag.toLowerCase();
  let bestMatch: { candidate: string; distance: number } | undefined;
  for (const candidate of knownComponents) {
    const normCandidate = candidate.toLowerCase();
    const distance = editDistance(normTag, normCandidate);
    if (distance <= 2 && (bestMatch === undefined || distance < bestMatch.distance)) {
      bestMatch = { candidate, distance };
    }
  }
  return bestMatch?.candidate;
};

/**
 * Strip the inner content of elements that can legitimately contain raw,
 * non-markup text — `script`, `style`, `textarea`, plus whatever the user
 * configured in `scoping.preserve` (defaults to `["code"]`).
 */
const stripElementContents = (html: string): string => {
  const extra = (BascikConfig.scoping?.preserve ?? [])
    .map((t) => String(t).replace(/[^a-zA-Z0-9-]/g, ""))
    .filter(Boolean);
  const protectedTags = ["script", "style", "textarea", ...extra];
  return maskElementContents(html, protectedTags);
};

export interface TagOccurrence {
  tag: string;
  line: number;
}

/**
 * Extract all hyphenated tag names from an HTML string along with line numbers.
 */
export const extractCustomTagOccurrences = (html: string): TagOccurrence[] => {
  // Strip comments first while preserving newlines
  const noComments = html.replace(/<!--[\s\S]*?-->/g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : " ";
  });
  const stripped = stripElementContents(noComments);
  const occurrences: TagOccurrence[] = [];
  const lines = stripped.split("\n");
  const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/gi;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex];
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(lineText)) !== null) {
      occurrences.push({
        tag: m[1].toLowerCase(),
        line: lineIndex + 1,
      });
    }
  }

  return occurrences;
};

/**
 * Extract all hyphenated tag names from an HTML string (legacy helper).
 */
export const extractCustomTags = (html: string): Set<string> => {
  const occs = extractCustomTagOccurrences(html);
  const tags = new Set<string>();
  for (const o of occs) {
    tags.add(o.tag);
  }
  return tags;
};

/** Return a human-readable relative path for a file. */
const toDisplay = (filePath: string): string => {
  try {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.includes(BascikConfig.directory?.pages?.replace(/\\/g, "/") ?? "src/pages")) {
      return getRelativePath(filePath, "pages");
    }
    if (normalized.includes(BascikConfig.directory?.components?.replace(/\\/g, "/") ?? "src/components")) {
      return getRelativePath(filePath, "components");
    }
  } catch {
    // fall through
  }
  try {
    return relative(process.cwd(), filePath).replace(/\\/g, "/");
  } catch {
    return filePath;
  }
};

/**
 * Extract all `<script data-bascik-build>` block contents from an HTML string.
 */
const extractBuildScripts = (html: string): string[] => {
  const scripts: string[] = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = match[1];
    const content = match[2];
    if (/\bdata-bascik-build\b/i.test(attrs)) {
      scripts.push(content);
    }
  }
  return scripts;
};

/**
 * Run the static check across pages, components, and API routes.
 * Produces structured data without printing.
 */
export const checkProject = async (): Promise<CheckFindings> => {
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
          occurrences: extractCustomTagOccurrences(html),
          buildScripts: extractBuildScripts(html),
        };
      } catch {
        return { filePath, occurrences: [], buildScripts: [] };
      }
    }),
  );

  const usedComponents = new Set<string>();
  const unmatchedTagLocations = new Map<string, FindingLocation[]>();

  // Check build script sources for string literal references to components
  for (const { buildScripts } of scanResults) {
    for (const scriptContent of buildScripts) {
      for (const comp of knownComponents) {
        // String literal check: e.g. "my-card", 'my-card', `my-card`
        const literalRegex = new RegExp(`["'\`]${comp}["'\`]`);
        if (literalRegex.test(scriptContent)) {
          usedComponents.add(comp);
        }
      }
    }
  }

  for (const { filePath, occurrences } of scanResults) {
    const displayPath = toDisplay(filePath);
    for (const { tag, line } of occurrences) {
      if (knownComponents.has(tag)) {
        usedComponents.add(tag);
      } else {
        const list = unmatchedTagLocations.get(tag) ?? [];
        list.push({ filePath: displayPath, line });
        unmatchedTagLocations.set(tag, list);
      }
    }
  }

  const items: CheckFinding[] = [];

  // Unmatched tags -> warnings
  for (const [tag, locations] of unmatchedTagLocations.entries()) {
    const suggestion = suggestComponentName(tag, knownComponents);
    items.push({
      category: "unmatched-tag",
      severity: "warning",
      message: `<${tag}>`,
      locations,
      suggestion,
    });
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
            items.push({
              category: "invalid-method-case",
              severity: "warning",
              message: `method export "${name}" must be uppercase ("${upper}"). Lowercase or mixed-case HTTP methods are not recognized by the dispatcher.`,
              locations: [{ filePath: toDisplay(filePath) }],
            });
          }
        }

        const hasRecognized = exportedNames.some((n) => VALID_API_METHODS.has(n));
        if (!hasRecognized) {
          items.push({
            category: "missing-method-handler",
            severity: "error",
            message: `file exports no recognized HTTP method handler (GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD).`,
            locations: [{ filePath: toDisplay(filePath) }],
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Check for collisions
    for (const [url, filePaths] of routesByUrl.entries()) {
      if (filePaths.length > 1) {
        items.push({
          category: "route-collision",
          severity: "error",
          message: `Route URL Collision: "${url}" is declared in multiple route files`,
          locations: filePaths.map((f) => ({ filePath: toDisplay(f) })),
        });
      }
    }
  }

  // Unused components -> warnings
  const unused = [...knownComponents].filter((c) => !usedComponents.has(c));
  for (const comp of unused) {
    const rawPath = componentList[comp]?.fileName;
    const locPath = rawPath ? toDisplay(rawPath) : comp;
    items.push({
      category: "unused-component",
      severity: "warning",
      message: comp,
      locations: [{ filePath: locPath }],
    });
  }

  const errors = items.filter((i) => i.severity === "error").length;
  const warnings = items.filter((i) => i.severity === "warning").length;

  return {
    errors,
    warnings,
    pagesChecked: pageList.length,
    componentsChecked: knownComponents.size,
    items,
  };
};

/** Category descriptive headers and explanations. */
const CATEGORY_META: Record<string, { title: string; description: string }> = {
  "unmatched-tag": {
    title: "Components with no matching file",
    description:
      "These are either typos, or third-party web components. Bascik does not\ntranspile them; they are passed through to the browser unchanged.",
  },
  "unused-component": {
    title: "Unused components",
    description:
      "Defined but never referenced. Safe to delete, or referenced only from a\nbuild script, which this check cannot always see.",
  },
  "missing-method-handler": {
    title: "API routes missing method handler",
    description: "API route files must export at least one standard HTTP method handler.",
  },
  "invalid-method-case": {
    title: "API route method exports with invalid casing",
    description: "HTTP method handlers must be uppercase (e.g. GET, POST).",
  },
  "route-collision": {
    title: "API route collisions",
    description: "Multiple API route files resolve to the same URL path.",
  },
};

/**
 * Format check findings into human-readable console output.
 */
export const formatFindingsHuman = (findings: CheckFindings): string => {
  const sections: string[] = ["bascik --check\n"];

  // Group items by category
  const grouped = new Map<string, CheckFinding[]>();
  for (const item of findings.items) {
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }

  if (findings.items.length === 0) {
    const warnNote = findings.warnings > 0 ? ` (${findings.warnings} warnings)` : "";
    return `bascik --check\n\n✓ ${findings.pagesChecked} page${findings.pagesChecked !== 1 ? "s" : ""} and ${findings.componentsChecked} component${findings.componentsChecked !== 1 ? "s" : ""} checked — no errors${warnNote}`;
  }

  for (const [category, items] of grouped.entries()) {
    const meta = CATEGORY_META[category] ?? {
      title: category,
      description: "",
    };
    const count = items.length;
    let section = `${meta.title} (${count})\n`;
    if (meta.description) {
      const indented = meta.description
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");
      section += `${indented}\n\n`;
    }

    for (const item of items) {
      if (category === "unmatched-tag") {
        const locStr = item.locations
          .map((loc) => (loc.line !== undefined ? `${loc.filePath}:${loc.line}` : loc.filePath))
          .join(", ");
        const tagFormatted = item.message.padEnd(18);
        section += `  ${tagFormatted} ${locStr}\n`;
        if (item.suggestion) {
          section += `                     did you mean <${item.suggestion}>?\n`;
        }
      } else if (category === "unused-component") {
        const loc = item.locations[0]?.filePath ?? item.message;
        section += `  ${loc}\n`;
      } else if (category === "route-collision") {
        section += `  ${item.message}\n`;
        for (const loc of item.locations) {
          section += `    - ${loc.filePath}\n`;
        }
      } else {
        const locStr = item.locations.map((loc) => loc.filePath).join(", ");
        section += `  ${item.message} (${locStr})\n`;
      }
    }
    sections.push(section);
  }

  const symbol = findings.errors > 0 ? "✗" : "✓";
  const summary = `${symbol} ${findings.errors} error${findings.errors !== 1 ? "s" : ""}, ${findings.warnings} warning${findings.warnings !== 1 ? "s" : ""}`;
  sections.push(summary);

  return sections.join("\n");
};

export interface CheckJsonOutput {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  findings: Array<{
    category: string;
    severity: FindingSeverity;
    message: string;
    locations: FindingLocation[];
    suggestion?: string;
  }>;
}

/**
 * Format check findings as a JSON string matching the documented schema.
 */
export const formatFindingsJson = (findings: CheckFindings): string => {
  const output: CheckJsonOutput = {
    errors: findings.errors,
    warnings: findings.warnings,
    pagesChecked: findings.pagesChecked,
    componentsChecked: findings.componentsChecked,
    findings: findings.items.map((item) => ({
      category: item.category,
      severity: item.severity,
      message: item.message,
      locations: item.locations,
      ...(item.suggestion ? { suggestion: item.suggestion } : {}),
    })),
  };
  return JSON.stringify(output, null, 2);
};
