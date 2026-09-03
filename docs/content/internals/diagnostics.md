# Diagnostics

Bascik includes a static analysis engine for project diagnostics (`bascik --check`) and a stack trace remapping utility (`stack-trace.ts`) that links runtime script errors back to source HTML files.

## Overview

Diagnostics in Bascik operate across two distinct phases:

1. **Build-time static analysis (`check.ts`)**: Scans source pages and components before compilation to detect missing component definitions, unused component files, and invalid tag syntax without executing arbitrary code.
2. **Runtime error remapping (`stack-trace.ts`)**: Intercepts unhandled exceptions in `<script data-bascik-build>` and `<script data-bascik-server>` blocks, remapping Node.js stack traces from ephemeral temp files back to the original source HTML file and line offset.

## Static Project Analysis (`check.ts`)

Running `bascik --check` validates project markup without starting a full build or web server. If errors are detected, the process exits with code 1, making it suitable for CI/CD status checks.

### Tag Extraction (`extractCustomTags`)

To locate custom component usages, `extractCustomTags` scans page and component HTML for custom hyphenated element tags (`<user-card>`, `<nav-header>`):

```ts
export const extractCustomTags = (html: string): Set<string> => {
  const stripped = stripElementContents(html.replace(/<!--[\s\S]*?-->/g, ""));
  const tags = new Set<string>();
  const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s\/>]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    tags.add(m[1].toLowerCase());
  }
  return tags;
};
```

Standard HTML tags (`<div>`, `<p>`, `<span>`) contain no hyphens and are ignored.

### Raw-Text Content Stripping (`stripElementContents`)

Source templates often contain sample code, embedded JSON-LD, or CSS rules that mention custom tag names in string literals or comments (such as `'<my-tag>'` inside a tutorial snippet). Unchecked, these strings would produce false-positive unknown tag errors.

Before custom tags are extracted, `stripElementContents` removes the inner content of elements that legitimately contain raw text:

- Standard protected elements: `<script>`, `<style>`, `<textarea>`
- User-configured skip elements: `skipTranspilingElementContents` (which defaults to `["code"]`)

```ts
const stripElementContents = (html: string): string => {
  const extra = (BascikConfig.skipTranspilingElementContents ?? [])
    .map((t) => String(t).replace(/[^a-zA-Z0-9-]/g, ""))
    .filter(Boolean);
  const protectedTags = ["script", "style", "textarea", ...extra];
  const re = new RegExp(
    `<(${protectedTags.join("|")})(\\s[^>]*)?>[\\s\\S]*?</\\1>`,
    "gi",
  );
  let prev: string;
  let out = html;
  do {
    prev = out;
    out = out.replace(re, "<$1$2></$1>");
  } while (out !== prev);
  return out;
};
```

A loop runs until output stabilizes to handle nested tags (such as `<code>...<code>...</code>...</code>`).

### Build Script Presence Heuristic

`<script data-bascik-build>` blocks execute arbitrary JavaScript at build time and can output component markup dynamically. Running build scripts during `bascik --check` would be slow and could cause unwanted side effects.

Rather than disabling the unused component check project-wide, `check.ts` checks build script source text for string literal references (e.g. `"my-card"`, `'my-card'`, or `` `my-card` ``). A component is marked as potentially used only when its name appears as a string literal in a build script. Unreferenced components continue to be reported as unused warnings.

### The Findings Model & Extension Points

`checkProject` returns a structured data model rather than writing directly to terminal streams:

```ts
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
```

This model decouples diagnostic analysis from presentation:
- **`formatFindingsHuman(findings)`**: Groups findings by category, renders file and line locations, suggests near-miss matches, and provides category descriptions.
- **`formatFindingsJson(findings)`**: Serializes the findings model to a stable JSON schema for CI automation.

#### Adding a New Check

To add a new validation check:
1. Perform static analysis during the scanning pass in `checkProject`.
2. Push a new `CheckFinding` object to `items` with an appropriate category identifier, severity (`"error"` or `"warning"`), message, and location array.
3. Add a category entry to `CATEGORY_META` in `check.ts` with a human-readable title and explanation for the terminal formatter.

### Diagnostics Output Summary

`bascik --check` produces categorized diagnostic reporting:

| Diagnostic Type | Category | Severity | Exit Code | Description |
| --- | --- | --- | --- | --- |
| Unknown Component Tag | `unmatched-tag` | Warning | 0 | A hyphenated tag was used in HTML, but no matching file exists in `src/components/`. Ships unchanged. |
| Unused Component File | `unused-component` | Warning | 0 | A component file exists in `src/components/`, but is never referenced in any page, component, or build script literal. |
| API Route Missing Handler | `missing-method-handler` | Error | 1 | An API route file exports no recognized HTTP method handler (`GET`, `POST`, etc.). |
| API Route Collision | `route-collision` | Error | 1 | Multiple API route files resolve to the same endpoint URL path. |
| API Route Invalid Case | `invalid-method-case` | Warning | 0 | Method export name is not uppercase (e.g. `get` instead of `GET`). |

## Aggregated Build Errors

Production transpilation settles every page job before deciding whether the build succeeded. Each failure is normalized into three fields: the source page path, the processing stage, and the original error message. The CLI prints one grouped report and exits with code 1:

```terminal
Build failed with 2 page errors:
  src/pages/about.html
    validate markup: Page does not contain a non-empty <body> element
  src/pages/blog/post.html
    write output: EACCES: permission denied
```

Stages include `validate markup`, `component expansion`, `create output directory`, `write output`, `transpile page`, and `worker transpile`. Missing or unreadable configured source directories fail before page processing begins. A subdirectory that disappears during recursive traversal is treated as a file-watch race: Bascik warns and continues scanning the remaining tree.

In dev mode the same page records are logged, but they do not reject the batch. This allows boot to complete and healthy pages to remain available while a failed page waits for the next save. Unresolved component tags are warning-only during transpilation; static analysis reports them as errors.

## Source Map & Stack Trace Remapping (`stack-trace.ts`)

During build and server execution, Bascik extracts `<script data-bascik-build>` and `<script data-bascik-server>` blocks into ephemeral temporary files before executing them with Node.js.

When a script throws an unhandled exception, Node.js formats the stack trace using the temporary file path and a 1-based line number relative to the temporary file's start:

```text
Error: Failed to fetch API data
    at file:///tmp/bascik-script-a1b2c3.mjs:4:11
```

### The `cleanStackTrace` Utility

`cleanStackTrace` intercepts raw trace strings and converts ephemeral file references back to the source HTML document:

```ts
export const cleanStackTrace = (
  rawTrace: string,
  tmpPath: string,
  realPath: string,
  lineOffset: number,
): string => {
  if (!rawTrace) return rawTrace;

  const escapedTmpPath = tmpPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let fileUri = tmpPath;
  try {
    fileUri = pathToFileURL(tmpPath).href;
  } catch {}
  const escapedFileUri = fileUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(`(?:${escapedFileUri}|${escapedTmpPath}):(\\d+)`, "g");

  return rawTrace.replace(regex, (match, lineStr) => {
    const lineNum = parseInt(lineStr, 10);
    const mappedLine = lineOffset + lineNum - 1;
    return `${realPath}:${mappedLine}`;
  });
};
```

### Terminal Link Integration

With `cleanStackTrace` applied, error output in the terminal references actual workspace files:

```text
Error: Failed to fetch API data
    at src/pages/dashboard.html:28
```

Developers can click or Cmd+Click the path in VS Code or supported terminals to jump straight to the exact line in their source HTML file.
