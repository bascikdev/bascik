# Diagnostics

Bascik includes a static analysis engine for project diagnostics (`bascik --check`) and a stack trace remapping utility (`stack-trace.ts`) that links runtime script errors back to source HTML files.

## Overview

Diagnostics in Bascik come from three places, each with one job:

1. **Project analysis (`check.ts`, in `@bascik/bascik`)**: answers questions about the whole project. Does the config make sense, do two pages claim one route, is a component never used. It needs the config, every page, and every component at once, so it cannot be done one file at a time.
2. **Per-file analysis (`@bascik/language-server`)**: answers questions about one file. Is this attribute a typo, can this CSS be scoped, does this API route export a handler. It needs only the text of the file, so it runs as you type in the editor, and `bascik --check` runs the same engine over the project. The VS Code extension is a thin client that starts this server, so it holds no rules of its own.
3. **Runtime error remapping (`stack-trace.ts`)**: intercepts unhandled exceptions in `<script data-bascik-build>` and `<script data-bascik-server>` blocks, remapping Node.js stack traces from ephemeral temp files back to the original source HTML file and line offset.

### Where each rule lives

A rule has exactly one home, so a finding is never reported twice and an editor squiggle always matches what CI says. The test for where a rule belongs is simple: **if it needs only one file, it belongs to the language server; if it needs the project, it belongs to `bascik --check`.**

| Home                                 | Rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bascik --check` (project)           | `config-validation`, `missing-site-url`, `pages-directory`, `duplicate-component-name`, `component-list`, `circular-component-reference`, `duplicate-route-resolution`, `unmatched-tag`, `unused-component`, `route-collision`, `invalid-catch-all`, `dist-html-spec`, `request-render-unsupported`, `request-render-csp-unstable`                                                                                                                                                                                                                                                                                                                                                                                           |
| `@bascik/language-server` (per file) | `unknown-bascik-attribute`, `unknown-directive-value`, `script-mode-conflict`, `directive-on-non-script`, `missing-prop-prefix`, `undeclared-prop`, `undeclared-slot`, `slot-outside-component`, `component-structure-order`, `component-name-not-hyphenated`, `unclosed-component-tag`, `prefer-self-closing-component`, `id-reference-undeclared`, `unknown-preserve-token`, `external-form-missing-preserve-name`, `shared-name-group`, `inline-and-companion-styles`, `middleware-unsupported`, `missing-method-handler`, `invalid-method-case`, `api-handler-return-type`, `leading-slash-specifier`, the `css-*` and `js-*` scoping-compatibility rules, the `server-script-*` rules, and the component metadata rules |

One per-file rule reads the rest of the project too: `shared-name-group` reports on a component file, but counts how many times each page renders that component (through nested components, with unsaved editor text), so the warning appears in the file to change while you type.

Two things are deliberately not duplicated:

- **The compiler's own warnings.** When it builds a component, Bascik prints the same scoping-compatibility warnings, because a build must not depend on an optional package. The matcher exists in both packages, and `docs/scripts/compat-matcher-parity.test.ts` fails if they ever disagree.
- **Build failures.** A script that combines two directives is a per-file rule (`script-mode-conflict`) and also a hard error when you build. The rule exists to tell you earlier.

### How `bascik --check` uses the language server

`@bascik/language-server` is an **optional peer dependency** of `@bascik/bascik`. Nothing installs it for you, and the compiler has no production dependencies. Projects scaffolded with `npm create bascik` already list it as a dev dependency.

When `bascik --check` runs, it loads the language server from the project (so the version you installed is the version that runs), hands it the pages folder (markup only), every component root, and the API folder (scripts only), and merges what comes back. Per-file findings are listed by file under their own heading, because that is how an editor shows them. Hints, which are advice for the editor and may be wrong for a project the file cannot see, are left out, so they can never fail a `--strict` run.

When the language server is **not installed**, the project checks still run and the report says what was skipped. `bascik --check --fix` exits 1 instead, because the fixes are the language server's and reporting "nothing fixed" would be a lie. When the installed language server is **too old** for this version of Bascik, the report says to update it.

The language server is also usable on its own, with no `bascik` involved: `npx bascik-language-server --check`. That is the right tool for a shared component library that has no site of its own.

## Static Project Analysis (`check.ts`)

Running `bascik --check` validates the project without starting a full build or web server. If errors are detected, the process exits with code 1, making it suitable for CI/CD status checks.

### Tag Extraction (`extractCustomTags`)

To locate custom component usages, `extractCustomTagOccurrences` scans page and component HTML for custom hyphenated element tags (`<user-card>`, `<nav-header>`):

```ts
export const extractCustomTagOccurrences = (html: string): TagOccurrence[] => {
  // Comments are blanked, keeping their newlines so line numbers stay right.
  const noComments = html.replace(/<!--[\s\S]*?-->/g, (match) => {
    const newlines = match.match(/\n/g);
    return newlines ? newlines.join("") : " ";
  });
  const stripped = stripElementContents(noComments);
  const occurrences: TagOccurrence[] = [];
  // The tag name ends where a browser ends it: at tag whitespace, `/` or `>`.
  const re = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\t\n\f\r \/>])/gi;
  let counted = 0;
  let line = 1;
  for (const m of stripped.matchAll(re)) {
    for (; counted < m.index; counted++)
      if (stripped.charCodeAt(counted) === 10) line++;
    occurrences.push({ tag: m[1].toLowerCase(), line });
  }
  return occurrences;
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
  // Keep entries that satisfy the scoping.preserve validation rule (tag names
  // and `*` wildcard patterns) and drop anything else.
  const extra = (BascikConfig.scoping?.preserve ?? [])
    .map((t) => String(t))
    .filter(
      (t) => PLAUSIBLE_TAG_NAME.test(t) || PRESERVE_WILDCARD_PATTERN.test(t),
    );
  const protectedTags = ["script", "style", "textarea", ...extra];
  return maskElementContents(html, protectedTags);
};
```

`maskElementContents` (`shielding.ts`) replaces each protected element's content with the same number of spaces, so offsets are unchanged.

### Build Script Presence Heuristic

`<script data-bascik-build>` blocks execute arbitrary JavaScript at build time and can output component markup dynamically. Running build scripts during `bascik --check` would be slow and could cause unwanted side effects.

Rather than disabling the unused component check project-wide, `check.ts` reads the source text of build, server and stream scripts, their `src=` modules, and the local modules they import. A component counts as used when its start tag is written there, or when its name appears as a whole string literal (e.g. `"my-card"`, `'my-card'`, or `` `my-card` ``). A tag name built in code cannot be followed; where a script builds one, the unused warning carries a note naming that line. Unreferenced components continue to be reported as unused warnings.

### The Findings Model & Extension Points

`checkProject` returns a structured data model rather than writing directly to terminal streams:

```ts
export type FindingSeverity = "error" | "warning";

export interface FindingLocation {
  filePath: string;
  line?: number;
  column?: number;
}

export interface CheckFinding {
  category: string; // the rule id
  severity: FindingSeverity;
  message: string;
  locations: FindingLocation[];
  suggestion?: string;
  note?: string; // a caveat shown under the finding
  source?: "language-server"; // set on per-file findings
}

export interface CheckFindings {
  errors: number;
  warnings: number;
  pagesChecked: number;
  componentsChecked: number;
  items: CheckFinding[];
  distHtmlChecked: number | null;
  distHtmlSpecHintNeeded: boolean;
  perFileChecked: number | null; // null when the language server did not run
  perFileHint?: string; // why it did not run
  fixedFiles: string[];
  perFileFormat?: (
    diagnostic: LanguageServerDiagnostic,
    color?: boolean,
  ) => string;
}
```

This model decouples diagnostic analysis from presentation:

- **`formatFindingsHuman(findings)`**: Groups project findings by category with descriptions and near-miss suggestions, then lists per-file findings by file, the way an editor shows them.
- **`formatFindingsJson(findings)`**: Serializes the findings model to a stable JSON schema for CI automation.

#### Adding a New Check

First decide where it belongs, using the test above: one file, or the whole project.

**A project check** (needs the config, the page list, or the route table):

1. Perform the analysis during the scanning pass in `checkProject`.
2. Push a new `CheckFinding` object to `items` with a category identifier, severity (`"error"` or `"warning"`), message, and location array.
3. Add a category entry to `CATEGORY_META` in `check.ts` with a human-readable title and explanation for the terminal formatter.

**A per-file check** (needs only the text of one file): add it to the language server's analyzer with a stable rule id in `code`. It then appears in the editor and in `bascik --check` with no change to `check.ts`, and `bascik-ignore <id>` and `disabledRules` work for it. Give an informational hint `DiagnosticSeverity.Information`, so it stays out of `--check`.

### Diagnostics Output Summary

`bascik --check` reports the project rules below itself. Per-file rules come from the language server and are listed after the table.

`bascik --check` produces categorized diagnostic reporting:

| Diagnostic Type              | Category                       | Severity      | Exit Code | Description                                                                                                                                                      |
| ---------------------------- | ------------------------------ | ------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown Component Tag        | `unmatched-tag`                | Warning       | 0         | A hyphenated tag was used in HTML, but no matching file exists in `src/components/`. Ships unchanged.                                                            |
| Unused Component File        | `unused-component`             | Warning       | 0         | A component file exists in `src/components/`, but is never referenced in any page, component, or build script literal.                                           |
| Config Validation            | `config-validation`            | Error/Warning | Depends   | Configuration validation results projected into findings with key-based severity mapping.                                                                        |
| Missing Site URL             | `missing-site-url`             | Warning       | 0         | `generate.sitemap` and/or `generate.robots` is enabled but no site URL is available. `bascik --build` fails on it.                                               |
| Pages Directory Issue        | `pages-directory`              | Error         | 1         | Configured pages directory cannot be read or contains no page HTML files.                                                                                        |
| Duplicate Component Name     | `duplicate-component-name`     | Error         | 1         | Multiple component files define the same custom tag name.                                                                                                        |
| Component Scan Failure       | `component-list`               | Error         | 1         | Component discovery failed (other than a duplicate tag name), so the check cannot rely on the component list.                                                    |
| Circular Component Reference | `circular-component-reference` | Error         | 1         | Direct or indirect component graph cycle detected (full cycle path included).                                                                                    |
| Duplicate Route Resolution   | `duplicate-route-resolution`   | Error         | 1         | Multiple pages resolve to the same route path.                                                                                                                   |
| API Route Collision          | `route-collision`              | Error         | 1         | Multiple API route files resolve to the same endpoint URL path, or two catch-all routes match the same requests.                                                 |
| API Invalid Catch-All        | `invalid-catch-all`            | Error         | 1         | A `[...name]` segment is unnamed, partial, repeated, or not the final segment.                                                                                   |
| dist/ HTML Spec Violation    | `dist-html-spec`               | Error         | 1         | A compiled `dist/` page does not parse cleanly (needs the optional parse5).                                                                                      |
| Request-time Unsupported     | `request-render-unsupported`   | Warning       | 0         | Components a server or stream script cannot return, read from the last build's component manifest, each with its reason.                                         |
| Request-time CSP Unstable    | `request-render-csp-unstable`  | Warning       | 0         | With `generate.cspHashes` on, components whose stylesheet or client scripts embed the instance id, so a script that returns them cannot satisfy a hash-only CSP. |

The per-file rules that `bascik --check` reports through the language server, with the same severities:

| Diagnostic Type            | Rule id                     | Severity      | Exit Code | Description                                                                                                                           |
| -------------------------- | --------------------------- | ------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unknown Bascik Directive   | `unknown-bascik-attribute`  | Warning       | 0         | A `data-bascik-*` attribute is unrecognized and likely a typo.                                                                        |
| Script Mode Conflict       | `script-mode-conflict`      | Error         | 1         | A script tag combines two script directives.                                                                                          |
| Unknown Directive Value    | `unknown-directive-value`   | Warning       | 0         | `data-bascik-build` and `data-bascik-build-once` do not take values.                                                                  |
| Missing Prop Prefix        | `missing-prop-prefix`       | Warning       | 0         | A component usage passes a declared prop as a plain attribute (`title="x"`) instead of `data-bascik-prop-title`. `--fix` rewrites it. |
| API Route Missing Handler  | `missing-method-handler`    | Error         | 1         | An API route file exports no recognized HTTP method handler (`GET`, `POST`, etc.).                                                    |
| API Route Invalid Case     | `invalid-method-case`       | Warning       | 0         | Method export name is not uppercase (e.g. `get` instead of `GET`).                                                                    |
| API Middleware             | `middleware-unsupported`    | Error         | 1         | A `_middleware.ts` file exists. Middleware chains are not supported by design.                                                        |
| Component Order Convention | `component-structure-order` | Warning       | 0         | Advises `<style>` above markup and `<script>` below markup in component templates. Does not apply when there is no literal markup.    |
| Scoping Compatibility      | `css-*`, `js-*`             | Error/Warning | 1/0       | CSS or JavaScript that cannot be reliably scoped. Applies to component files only.                                                    |

`missing-required-prop` is intentionally omitted from the diagnostics model. The low-cost project-wide signal is noisy for real sites (conditional render paths and dynamic content supply), and `--check` favors actionable findings over speculative warnings.

### Worked Extension Examples

- **Unknown directive checks** (per file, language server): scan open tags for `data-bascik-*`, compare against the known attribute set, and emit `unknown-bascik-attribute` warnings positioned on the attribute name.
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

In dev mode the same page records are logged, but they do not reject the batch. This allows boot to complete and healthy pages to remain available while a failed page waits for the next save. Unmatched custom component tags emit a warning (and `bascik --check --strict` exits with code 1 on them).

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
