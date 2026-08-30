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

Instead, when `check.ts` detects a `<script data-bascik-build>` block in a file, it marks every known component as "potentially used" by that page. Because unused component warnings are non-fatal, this heuristic prevents false-positive warnings without compromising error detection for static markup.

### Diagnostics Output Summary

`bascik --check` produces categorized diagnostic reporting:

| Diagnostic Type | Severity | Exit Code | Description |
| --- | --- | --- | --- |
| Unknown Component Tag | Error | 1 | A hyphenated tag (e.g. `<missing-btn>`) was used in HTML, but no matching file exists in `src/components/`. |
| Unused Component File | Warning | 0 | A component file exists in `src/components/`, but is never referenced in any page or component file. |

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
