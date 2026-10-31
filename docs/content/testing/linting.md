# Linting

Bascik projects use two complementary linting tools:

1. **Bascik Linter (`@bascik/language-server`)**: Validates component tags, undeclared props, slots, mutually exclusive script directives, and CSS/JS scoping rules in your editor, and from the command line through [`bascik --check`](/cli#static-analysis-with-bascik-check), which is what `npm run lint` runs in a scaffolded project. `bascik --check` adds the project-wide checks, so one CI step covers both. See the [Linter](/tools/linter) guide.
2. **Web Standards & Accessibility Linter (`webhint`)**: Audits HTML for W3C web standards, cross-browser compatibility, and accessibility, in the editor through the [webhint VS Code extension](https://marketplace.visualstudio.com/items?itemName=webhint.vscode-webhint) and on the built site through the `hint` CLI (`npx hint`).

Neither tool decides which elements you use. [Component Best Practices](/component-best-practices#use-htmls-elements) covers picking them, and the `bascik` agent skill's `audit-components.mjs` warns about a clickable `<div>`, a wrapper `<div>` root, a skipped heading level, missing `alt`, an unlabeled control, and a page with no `<main>`.

## Editor Linters Read Source

Editor linters such as webhint, the axe Accessibility Linter, html-validate, HTMLHint, and VS Code's built-in HTML checker read the files in `src/`. Bascik writes the files in `dist/`, and some of what a page needs is only there:

- **A page's `<head>` is composed at build time.** The charset and viewport `<meta>` tags usually come from a head component such as `<site-head />`, and the `<title>` from a build script such as the SEO example's `seo()` helper. The source page has none of them, so linters report `'charset' meta element was not specified`, `A 'viewport' meta element was not specified`, and `Documents must have <title> element`. The built page has all three.
- **Props fill in attributes and text.** `<img data-bascik-attr-alt="alt">` gets its `alt` from the prop, and `<h1 data-bascik-prop-heading>` gets its text from it, so a linter sees an image with no `alt` and an empty heading.
- **Components are fragments in Bascik syntax.** A component file has no doctype, and a page writes component tags self-closed (`<site-head />`), which strict HTML linters reject.

These warnings are false for a Bascik project. Do not "fix" one by adding a second charset, viewport, or `<title>` to a source page: the built page would then have two. Open the built page in `dist/` first. If the tag is there, the warning is false; if it is missing there too, fix the head component or build script.

Everything else a linter reports is real. A `<button>` with no `type`, an `<html>` with no `lang`, and an `<img>` with a literal `src` and no `alt` are wrong in `dist/` too.

| Tool          | Warning                                                                                               | Why it is false in source                                 | What to set                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| webhint       | `meta-viewport`, `meta-charset-utf-8`                                                                 | A head component adds the tags at build time              | `.hintrc` `ignoredUrls` for source files (written for you)                                                                           |
| webhint       | `axe/text-alternatives`: `document-title`                                                             | A build script writes `<title>` at build time             | `.hintrc` hint option `"document-title": "off"` (written for you)                                                                    |
| webhint       | `axe/text-alternatives`: `image-alt`                                                                  | `alt` comes from a `data-bascik-attr-alt` prop            | `.hintrc` hint option `"image-alt": "off"` (written for you); the `bascik` skill's audit still flags a literal `<img>` with no `alt` |
| html-validate | `element-required-content` (a `<head>` needs a `<title>`)                                             | Composed at build time                                    | `"off"` in `src/.htmlvalidate.json`                                                                                                  |
| html-validate | `element-required-attributes`, `wcag/h37` (`<img>` `src`, `alt`)                                      | The values come from props                                | `"off"` in `src/.htmlvalidate.json`                                                                                                  |
| html-validate | `empty-heading`                                                                                       | The text comes from a `data-bascik-prop-*` prop           | `"off"` in `src/.htmlvalidate.json`                                                                                                  |
| html-validate | `no-self-closing`                                                                                     | Self-closed component tags are Bascik syntax              | `"off"` in `src/.htmlvalidate.json`                                                                                                  |
| html-validate | `doctype-style`, `void-style`                                                                         | Prettier writes `<!doctype html>` and `<meta />`          | `{ "style": "lowercase" }` and `{ "style": "selfclose" }`                                                                            |
| HTMLHint      | `title-require`                                                                                       | Composed at build time                                    | `false` in `src/.htmlhintrc`                                                                                                         |
| HTMLHint      | `doctype-first`                                                                                       | Components are fragments                                  | `false` in `src/.htmlhintrc`                                                                                                         |
| axe Linter    | `document-title`, `image-alt`, where it checks them                                                   | As for webhint                                            | `axe-linter.yml` `rules`                                                                                                             |
| VS Code HTML  | `A module cannot have multiple default exports`, TypeScript errors in `type="text/typescript"` blocks | Bascik compiles each script on its own and resolves `@/`  | `"html.validate.scripts": false` (written for you)                                                                                   |
| cSpell        | `Unknown word` on a brand, product, or person's name                                                  | Not false: the name is real but unknown to the dictionary | Add it to the project word list (`cspell.json` `"words"`)                                                                            |

None of these linters reports `data-bascik-*` attributes or `type="text/typescript"`: `data-` attributes are valid HTML.

### The Files `npm create bascik` Writes

`npm create bascik` and `bascik init` write a `.hintrc` that the webhint VS Code extension and the `hint` CLI read, and a `.hintrc.dist.json` for the built site:

```jsonc
// .hintrc
{
  "extends": ["development"],
  "hints": {
    "axe/text-alternatives": [
      "default",
      { "document-title": "off", "image-alt": "off" },
    ],
  },
  "ignoredUrls": [
    {
      "domain": "/(?:src/pages|src/components)/[^?#]*\\.html$",
      "hints": ["meta-viewport", "meta-charset-utf-8"],
    },
  ],
}
```

```json
// .hintrc.dist.json
{
  "extends": ["./.hintrc"],
  "hints": { "axe/text-alternatives": "default" }
}
```

- **The charset and viewport hints stay on everywhere but source.** webhint tests each `ignoredUrls` pattern, without regard to case, against the file's absolute `file:///` URL. The pattern starts at a `/` and ends at `.html`, so it skips HTML files in the pages and components folders and nothing in `dist/`.
- **`document-title` and `image-alt` are options of one hint.** `ignoredUrls` can only skip whole hints, and `axe/text-alternatives` holds a dozen other checks worth keeping, so `.hintrc` turns the two options off for every file and `.hintrc.dist.json` turns them back on.
- **Custom folders.** `bascik init` builds the pattern from `directory.pages` and `directory.components` in `bascik.config`. If you change those folders later, edit the pattern.
- **Existing files are merged.** An existing `.hintrc` or `.hintrc.json` keeps its comments and settings, and a value you set for `axe/text-alternatives` is kept. A `.hintrc.js` or a `package.json` `hintConfig` is left alone, and a file that is not valid JSON is left as it is; in each case the command prints what to add.
- **The pattern cannot be anchored to the project.** Because it runs on the absolute path, a project inside a parent folder named `src/pages` or `src/components` matches it in `dist/` too.
- **Open the project folder itself.** The webhint extension reads `.hintrc` only from the workspace folder (then your home folder), so opening a parent folder ignores the project's file.

The webhint extension checks a file when you open or edit it, not every file in the workspace.

### Check the Built Site

The checks that decide whether a page is right run on the built output:

```sh
npx bascik --check
npx bascik --build
npx hint -c .hintrc.dist.json $(find dist -name '*.html')
```

`bascik --check` covers Bascik syntax (component tags, props, slots, and scoping) and parses every built page against the WHATWG HTML spec. `hint` with `.hintrc.dist.json` checks the built pages with every hint on. Pass it files, not the `dist` folder: given a folder, webhint skips some hints, including `axe/text-alternatives` and `meta-charset-utf-8`. Lighthouse on the served build (`bascik --server`) checks the same head tags and accessibility rules in a browser.

### Other Editor Linters

Each of these merges config files up the folder tree or reads one per folder, so the source exceptions go in `src/` and the root config stays strict for `dist/`.

html-validate, at the project root:

```json
{
  "root": true,
  "extends": ["html-validate:recommended"],
  "rules": {
    "doctype-style": ["error", { "style": "lowercase" }],
    "void-style": ["error", { "style": "selfclose" }]
  }
}
```

and in `src/.htmlvalidate.json`:

```json
{
  "rules": {
    "no-self-closing": "off",
    "element-required-content": "off",
    "element-required-attributes": "off",
    "wcag/h37": "off",
    "empty-heading": "off"
  }
}
```

`no-self-closing` has no option for custom elements, so it is off in `src/`.

HTMLHint, in `src/.htmlhintrc` (the HTMLHint VS Code extension reads the nearest one; the `htmlhint` CLI takes it with `--config`):

```json
{
  "title-require": false,
  "doctype-first": false
}
```

The axe Accessibility Linter reads `axe-linter.yml` at the project root. Its `exclude` setting skips whole files, so turn the two rules off instead:

```yaml
rules:
  document-title: false
  image-alt: false
```

cSpell reports `Unknown word` for names it has never seen. That is not a Bascik exception: add the site's brand, product, and people names to a project word list so every editor and CI run shares it:

```json
{
  "version": "0.2",
  "words": ["bascik", "frother"]
}
```

## More Webhint Settings

These are not Bascik exceptions, but projects often add them to `.hintrc`:

```json
{
  "hints": {
    "apple-touch-icons": "off",
    "detect-css-reflows/paint": "off",
    "detect-css-reflows/composite": "off",
    "compat-api/css": [
      "default",
      { "ignore": ["scrollbar-width", "scrollbar-width: none"] }
    ],
    "compat-api/html": ["default", { "ignore": ["meta[name=theme-color]"] }]
  },
  "ignoredUrls": [
    {
      "domain": "/(e2e|test-results|coverage|hint-report)/",
      "hints": ["*"]
    }
  ]
}
```

- **`apple-touch-icons`**: touch icons belong in the head component, and the hint asks for a specific set of sizes.
- **`detect-css-reflows/*`**: interactive components often animate opacity, transform, or colors; these hints are noisy for that.
- **`compat-api/css` and `compat-api/html`**: allow a feature used as progressive enhancement, where browsers without support fall back.
- **`ignoredUrls`**: skips test output and reports. Wrap the folder names in `/` so the pattern matches a folder, not any path that contains the word: `".*(dist|e2e).*"` would also match a project stored under `~/distro-site/` and turn every hint off there.

## Component Authoring Best Practices

When authoring Bascik components with Webhint enabled:

### 1. Explicit Button Types

Webhint checks that all `<button>` elements declare an explicit `type` attribute:

```html
<!-- Good: explicit type prevents default form submission -->
<button type="button" class="toggle-btn">Toggle Panel</button>

<!-- Avoid: defaults to type="submit" and triggers Webhint warning -->
<button class="toggle-btn">Toggle Panel</button>
```

### 2. Accessible Form Elements

Every form control requires an accessible label, `aria-label`, or `title` attribute:

```html
<!-- Accessible text input -->
<label for="user-email">Email Address</label>
<input id="user-email" name="email" type="email" />

<!-- Accessible hidden or icon-only input -->
<input
  name="csrf_token"
  type="hidden"
  title="CSRF Token"
  aria-label="CSRF Token"
/>
```

### 3. Valid Custom Element Names

Custom component tags must contain a hyphen and start with a lowercase letter according to WHATWG HTML specifications:

```html
<!-- Valid Bascik component tags -->
<site-nav />
<user-profile-card />

<!-- Invalid custom tags -->
<navcard />
<UserProfile />
```

## Running Lint Checks in CI

Run the standards check on the built pages, next to Bascik's own checks (`hint` is a dev dependency: `npm install -D hint`):

```json
{
  "scripts": {
    "check:standards": "bascik --build && hint -c .hintrc.dist.json $(find dist -name '*.html')"
  }
}
```

```sh
npx bascik --check && npm run check:standards
```

`$(find ...)` needs a POSIX shell (macOS, Linux, Git Bash, or WSL). On Windows `cmd`, list the files or run Lighthouse instead.

### Strict CI Gates with `--strict`

To fail CI pipelines if any warnings exist (such as unmatched tags or unused components), pass `--strict`:

```sh
npx bascik --check --strict && npm run check:standards
```

## CI Gating Strategy for `bascik --check`

Use two gates in CI, one blocking and one advisory:

1. Blocking gate (default): `npx bascik --check`
2. Advisory gate (optional): `npx bascik --check --strict`

Blocking categories are typically `error` findings, including configuration failures, circular component references, route collisions, script mode conflicts, and API handler errors.

Advisory categories are typically `warning` findings, including unknown `data-bascik-*` attributes and component ordering convention findings.

If your team wants warning-free enforcement, use `--strict` in required CI checks.

### Machine-Readable Diagnostics with `--json`

To integrate Bascik diagnostics with CI summary reporters or automated PR bots, pass `--json`:

```sh
npx bascik --check --json > check-report.json
```
