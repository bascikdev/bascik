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
- User-configured preserve tags: `scoping.preserve` (which defaults to `["code"]`)

```ts
const stripElementContents = (html: string): string => {
  const extra = (BascikConfig.scoping?.preserve ?? [])
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
| Config Validation | `config-validation` | Error/Warning | Depends | Configuration validation results projected into findings with key-based severity mapping. |
| Missing Site URL | `missing-site-url` | Error | 1 | `generate.sitemap` and/or `generate.robots` is enabled but no site URL is available. |
| Pages Directory Issue | `pages-directory` | Error | 1 | Configured pages directory cannot be read or contains no page HTML files. |
| Duplicate Component Name | `duplicate-component-name` | Error | 1 | Multiple component files define the same custom tag name. |
| Circular Component Reference | `circular-component-reference` | Error | 1 | Direct or indirect component graph cycle detected (full cycle path included). |
| Unknown Bascik Directive | `unknown-bascik-attribute` | Warning | 0 | A `data-bascik-*` attribute is unrecognized and likely a typo. |
| Script Mode Conflict | `script-mode-conflict` | Error | 1 | A script tag has both `data-bascik-build` and `data-bascik-server`. |
| Duplicate Route Resolution | `duplicate-route-resolution` | Error | 1 | Multiple pages resolve to the same route path. |
| API Route Missing Handler | `missing-method-handler` | Error | 1 | An API route file exports no recognized HTTP method handler (`GET`, `POST`, etc.). |
| API Route Collision | `route-collision` | Error | 1 | Multiple API route files resolve to the same endpoint URL path, or two catch-all routes match the same requests. |
| API Invalid Catch-All | `invalid-catch-all` | Error | 1 | A `[...name]` segment is unnamed, partial, repeated, or not the final segment. |
| API Route Invalid Case | `invalid-method-case` | Warning | 0 | Method export name is not uppercase (e.g. `get` instead of `GET`). |
| Component Order Convention | `component-structure-order` | Warning | 0 | Advises `<style>` above markup and `<script>` below markup in component templates. |

`missing-required-prop` is intentionally omitted from the diagnostics model. The low-cost project-wide signal is noisy for real sites (conditional render paths and dynamic content supply), and `--check` favors actionable findings over speculative warnings.

### Worked Extension Examples

- **Unknown directive checks**: scan stripped HTML for `data-bascik-*`, compare against known directive sets, and emit `unknown-bascik-attribute` warnings with line locations.
- **Cycle checks**: build a component dependency graph from custom-tag occurrences, then DFS for back-edges and report each full cycle path.
- **Config reuse checks**: call `validateUserConfig(...)`, map each returned key to check-level severity, and emit `config-validation` findings instead of writing directly to stderr.

## Aggregated Build Errors

Production transpilation settles every page job before deciding whether the build succeeded. Each failure is normalized into three fields: the source page path, the processing stage, and the original error message. The CLI prints one grouped report and exits with code 1:

```terminal
Build failed with 2 page errors:
  src/pages/about.html
    validate markup: Page does not contain a non-empty <body> element
  src/pages/blog/post.html
    write output: EACCES: permission denied
```

Stages include `validate markup`, `component expansion`, `create output directory`, `write output`, `transpile page`, and `worker transpile`. Missing or unreadable configured source directories fail before page processing begins. The one exception is the default components root: a missing `src/components/` means the project has no components, and an unmatched tag is still reported. Any other missing components root fails with a message that names the path. A subdirectory that disappears during recursive traversal is treated as a file-watch race: Bascik warns and continues scanning the remaining tree.

In dev mode the same page records are logged, but they do not reject the batch. This allows boot to complete and healthy pages to remain available while a failed page waits for the next save. Unmatched custom component tags emit a warning by default (and exit with code 1 when `--strict` is passed).

## Source Map & Stack Trace Remapping (`stack-trace.ts`)

Each directive script runs as a module of its own. Build and routes scripts are written to a temporary `.mjs` file and run in a fresh Node.js child process. Server and stream scripts run in-process: an inline one is imported from a `data:` URL, and a `src=` one from its own file. Either way, V8 numbers the module's lines from 1. Bascik makes those numbers the file's own in four steps:

1. **Record the position when the file is read** (`directive-source.ts`). `stampDirectiveSources` adds `data-bascik-source-file`, `data-bascik-source-line`, `data-bascik-source-column` (where the body starts), and `data-bascik-source-tag` (where the opening tag starts) to every directive script in a page or component as soon as it is read from disk. It matches whole elements, so tag-like text inside a browser script, a `<style>`, a `<textarea>`, or a comment is never stamped. Later steps move scripts: a component's `<style>` blocks are extracted, a dynamic route's routes script is removed, components are expanded into the page, and the HTML may be minified. The attributes add no newlines, and they never reach the output: build and routes scripts are replaced, and server scripts are extracted to the sidecar (which keeps `sourceLine` and `sourceColumn`).
2. **Line the module up with that position.** For build and routes scripts, `padToSourcePosition` puts the untrimmed body at its recorded line and column, and the module ends in `//# sourceURL=<file>`, so V8 reports the file's lines and columns directly. Inline server and stream scripts are not padded: their module text is their identity in the in-process script registry, and the same script used on several pages at different positions must stay one module with shared state. Their errors are mapped instead: `trimmedStartPosition` finds where the trimmed module's first character is in the file, and `cleanStackTrace` adds that line offset, plus a column offset on the module's first line. A `src=` script is its own file and needs neither.
3. **Undo the specifier rewrite** (`remapRewrittenColumns`). Bascik rewrites import specifiers to file URLs, which are longer than `./helper.ts`. The rewrite never adds a newline, so lines are unchanged, but columns after an import on the same line move. `rewriteModuleSpecifiersWithEdits` records each edit (build and routes scripts are padded first, so the edits are already in file coordinates), and the columns in that module's frames are moved back before the report is cleaned.
4. **Clean the report** (`stack-trace.ts`). `cleanStackTrace` renames the temp module path (which appears in syntax-error headers) to the source file, and removes Node.js internal frames, Node's version trailer, Bascik's own frames (the files directly in `lib/`), and builtin frames left after the user's last frame. Set `BASCIK_KEEP_INTERNAL_FRAMES=1` to keep Bascik's frames when a failure starts inside Bascik itself, such as in a module hook.

A caught `SyntaxError` from `import()` carries no location, so the build-script runner re-throws it at the module's top level, where Node prints the file, the line, and a caret. The runner removes its own `runner.mjs` frames and returns one message carrying the whole report, which the caller prints once. When Node stops the child itself (output over `maxBuffer`, or a spawn failure), the message keeps Node's reason first, followed by what the script logged. Server scripts run in-process, where an in-process `import()` reports a syntax error with only Node's loader frames, so `runServerScriptJob` adds the file and the line the script starts on. The script registry returns failures without logging them, `runServerScriptJob` reports them according to `onServerScriptError`, and a `ServerScriptError` is printed by its message alone, so Bascik's request-handling stack never follows it.

### Terminal Link Integration

The header and the stack name the file the same way, as a path from the project root:

```text
[bascik] build script error in "src/components/team-card/team-card.html" at (line 7, column 1):
Error: Could not load the team list
    at Module.default (src/components/team-card/team-card.html:9:11)
```

Developers can click or Cmd+Click the path in VS Code or supported terminals to jump straight to the exact line in their source HTML file.
