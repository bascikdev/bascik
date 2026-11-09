# Linting

Bascik's linter checks Bascik syntax. Third-party standards and accessibility linters are optional:

1. **Bascik Linter (`@bascik/language-server`)**: Validates component tags, undeclared props, slots, mutually exclusive script directives, and CSS/JS scoping rules in your editor, and from the command line through [`bascik --check`](/cli#static-analysis-with-bascik-check), which is what `npm run lint` runs in a scaffolded project. `bascik --check` adds the project-wide checks, so one CI step covers both. See the [Linter](/tools/linter) guide.
2. **Optional Web Standards & Accessibility Linter (`webhint`)**: Audits HTML for W3C web standards, cross-browser compatibility, and accessibility, in the editor through the [webhint VS Code extension](https://marketplace.visualstudio.com/items?itemName=webhint.vscode-webhint) and on the built site through the `hint` CLI (`npx hint`).

Neither `npm create bascik@rc` nor `bascik init` installs third-party linters, adds them as dependencies, or creates or modifies their config files. If you choose one, copy the relevant settings below and adapt them to your project.

Neither tool decides which elements you use. [Component Best Practices](/component-best-practices#use-htmls-elements) covers picking them, and the `bascik` agent skill's `audit-components.mjs` warns about a clickable `<div>`, a wrapper `<div>` root, a skipped heading level, missing `alt`, an unlabeled control, and a page with no `<main>`.

## Editor Linters Read Source

Editor linters such as webhint, the axe Accessibility Linter, html-validate, HTMLHint, and VS Code's built-in HTML checker read the files in `src/`. Bascik writes the files in `dist/`, and some of what a page needs is only there:

- **A page's `<head>` is composed at build time.** The charset and viewport `<meta>` tags usually come from a head component such as `<site-head />`, and the `<title>` from a build script such as the SEO example's `seo()` helper. The source page has none of them, so linters report `'charset' meta element was not specified`, `A 'viewport' meta element was not specified`, and `Documents must have <title> element`. The built page has all three.
- **Head components are fragments.** A component such as `<site-meta />` that holds the `<link rel="apple-touch-icon">` has no `<head>` of its own, so webhint reports `The 'apple-touch-icon' link element should be specified in the '<head>'`. In the built page the link is in `<head>`.
- **Props fill in attributes and text.** `<img data-bascik-attr-alt="alt">` gets its `alt` from the prop, and `<h1 data-bascik-prop-heading>` gets its text from it, so a linter sees an image with no `alt` and an empty heading.
- **Components are fragments in Bascik syntax.** A component file has no doctype, and a page writes component tags self-closed (`<site-head />`), which strict HTML linters reject.

These warnings are false for a Bascik project. Do not "fix" one by adding a second charset, viewport, or `<title>` to a source page: the built page would then have two. Open the built page in `dist/` first. If the tag is there, the warning is false; if it is missing there too, fix the head component or build script.

Everything else a linter reports is real. A `<button>` with no `type`, an `<html>` with no `lang`, and an `<img>` with a literal `src` and no `alt` are wrong in `dist/` too. Two exceptions below are wider than the false warning, because the linter has no narrower setting:

- The optional `.hintrc` below turns webhint's `image-alt` check off for every source file, so the webhint extension does not show a literal `<img>` with no `alt` either.
- `src/.htmlvalidate.json` stops html-validate requiring `src` on an `<img>`, so it does not show an `<img>` with no `src` at all. It still reports a missing `alt`, and a missing `lang` on `<html>`.

The [built-site check](#check-the-built-site) and the `bascik` skill's `audit-components.mjs` report a missing `alt`, and html-validate's root config reports a missing `src` when you run it on `dist/`.

| Tool          | Warning                                                                                               | Why it is false in source                                 | What to set                                                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| webhint       | `meta-viewport`, `meta-charset-utf-8`, `apple-touch-icons`                                            | A head component adds the tags at build time              | Optional `.hintrc` `ignoredUrls` for source files                                                                                                                              |
| webhint       | `axe/text-alternatives`: `document-title`                                                             | A build script writes `<title>` at build time             | Optional `.hintrc` hint option `"document-title": "off"`                                                                                                                       |
| webhint       | `axe/text-alternatives`: `image-alt`                                                                  | `alt` comes from a `data-bascik-attr-alt` prop            | Optional `.hintrc` hint option `"image-alt": "off"`. The editor then misses a literal `<img>` with no `alt` too; the built-site check and the `bascik` skill's audit report it |
| html-validate | `element-required-content` (a `<head>` needs a `<title>`)                                             | Composed at build time                                    | `"off"` in `src/.htmlvalidate.json`                                                                                                                                            |
| html-validate | `element-required-attributes` (`<img>` `src`)                                                         | The value comes from a `data-bascik-attr-src` prop        | `src/.htmlvalidate.json` `elements` makes `src` optional on `<img>` only. A literal `<img>` with no `src` then shows only when html-validate checks `dist/`                    |
| html-validate | `wcag/h37` (`<img>` `alt`)                                                                            | The value comes from a `data-bascik-attr-alt` prop        | `src/.htmlvalidate.json` option `"alias": ["data-bascik-attr-alt"]`, which still reports a literal `<img>` with no `alt`                                                       |
| html-validate | `empty-heading`                                                                                       | The text comes from a `data-bascik-prop-*` prop           | `"off"` in `src/.htmlvalidate.json`                                                                                                                                            |
| html-validate | `no-self-closing`                                                                                     | Self-closed component tags are Bascik syntax              | `"off"` in `src/.htmlvalidate.json`                                                                                                                                            |
| html-validate | `doctype-style`, `void-style`                                                                         | Prettier writes `<!doctype html>` and `<meta />`          | `{ "style": "lowercase" }` and `{ "style": "selfclose" }`                                                                                                                      |
| HTMLHint      | `title-require`                                                                                       | Composed at build time                                    | `false` in `src/.htmlhintrc`, which lists the default rules too                                                                                                                |
| HTMLHint      | `doctype-first`                                                                                       | Components are fragments                                  | `false` in `src/.htmlhintrc`, which lists the default rules too                                                                                                                |
| axe Linter    | `document-title`, `image-alt`, where it checks them                                                   | As for webhint                                            | `axe-linter.yml` `rules`                                                                                                                                                       |
| VS Code HTML  | `A module cannot have multiple default exports`, TypeScript errors in `type="text/typescript"` blocks | Bascik compiles each script on its own and resolves `@/`  | `"html.validate.scripts": false` (written for you)                                                                                                                             |
| cSpell        | `Unknown word` on a brand, product, or person's name                                                  | Not false: the name is real but unknown to the dictionary | Add it to the project word list (`cspell.json` `"words"`)                                                                                                                      |

None of these linters reports `data-bascik-*` attributes or `type="text/typescript"`: `data-` attributes are valid HTML.

### Optional Webhint Configuration

If you use the webhint VS Code extension, copy this `.hintrc` into the project root. For a CLI audit of built pages, copy the separate `.hintrc.dist.json` too. These files are not generated by Bascik, and using the editor extension does not require adding a project dependency.

`.hintrc`:

```json
{
  "extends": ["development"],
  "hints": {
    "axe/text-alternatives": [
      "default",
      { "document-title": "off", "image-alt": "off" }
    ]
  },
  "ignoredUrls": [
    {
      "domain": "/(?:src/pages|src/components)/[^?#]*\\.html$",
      "hints": ["meta-viewport", "meta-charset-utf-8", "apple-touch-icons"]
    }
  ]
}
```

`.hintrc.dist.json`:

```json
{
  "extends": ["development"],
  "formatters": ["stylish"]
}
```

The examples assume `src/pages`, `src/components`, and `dist`. Keep your existing linter settings when incorporating them. The [built-site check](#check-the-built-site) uses the strict config independently of the editor's exceptions.

- **Both files are plain JSON, with no comments.** The webhint extension's quick fixes, such as "Ignore hint in this project" and "Edit .hintrc for current project", read `.hintrc` with `JSON.parse`, so a comment or trailing comma makes them fail, and a quick fix that succeeds writes the file back without comments. VS Code opens `.hintrc.dist.json` as plain JSON and marks a comment there as an error. Keep the reasons on this page, not in the files.
- **The charset, viewport, and touch icon hints are skipped for source files only.** webhint tests each `ignoredUrls` pattern, without regard to case, against the file's absolute, percent-encoded `file:///` URL. The pattern starts at a `/` and ends at `.html`, so it skips HTML files in folders named like the pages and components folders. For a folder with spaces or non-ASCII characters, account for URL encoding when adapting the pattern: `site pages` can be matched with `site(?: |%20)pages`.
- **The pattern cannot be anchored to the project.** Because it runs on the absolute path, a folder of the same name anywhere in the path matches it too: a project inside a parent folder named `src/pages`, or, with `directory.pages: "pages"`, a built route such as `dist/pages/a.html` opened in the editor. That affects only `.hintrc`: the built-site check does not read it.
- **`.hintrc.dist.json` stands on its own.** webhint joins the `ignoredUrls` lists of every config in an `extends` chain, so a config that extended `.hintrc` would skip the source pattern, and any entry of yours that skips `dist/`, on the built pages. It extends `development` with every hint on, and its `stylish` formatter prints to the terminal instead of writing a `hint-report/` folder. A hint you turn off for the whole project in `.hintrc` needs the same line here.
- **`document-title` and `image-alt` are options of one hint.** `ignoredUrls` can only skip whole hints, and `axe/text-alternatives` holds a dozen other checks worth keeping, so `.hintrc` turns the two options off for every file. The editor then shows no `<img>` with a missing `alt`, even a literal one; the built-site check does.
- **Custom folders.** Adapt the pattern to `directory.pages` and `directory.components` in your `bascik.config`. If `directory.out` is not `dist`, use your output folder in the built-site command too.
- **Existing files stay yours.** Bascik does not read or modify `.hintrc`, `.hintrc.json`, `.hintrc.js`, `.hintrc.dist.json`, or `package.json` `hintConfig` during setup. Add the source exceptions to your existing config by hand rather than replacing your settings. For an existing `axe/text-alternatives` severity, keep it and add the two options, for example `["error", { "document-title": "off", "image-alt": "off" }]`.
- **If you copied the earlier Bascik `.hintrc`.** It turned `meta-viewport` and `meta-charset-utf-8` off in `hints` for every file. Remove those two lines: the `ignoredUrls` entry skips them for source files only. An old `ignoredUrls` entry that skips every hint in `dist/` quiets only the editor when `.hintrc.dist.json` does not read `.hintrc`.
- **Open the project folder itself.** The webhint extension reads `.hintrc` only from the workspace folder (then your home folder), so opening a parent folder ignores the project's file.

The webhint extension checks a file when you open or edit it, not every file in the workspace.

### Check the Built Site

The checks that decide whether a page is right run on the built output. If you opt into Webhint, first copy `.hintrc.dist.json` above; `npx hint` can run the optional CLI without adding it to your project dependencies:

```sh
npx bascik --check
npx bascik --build
npx hint -c .hintrc.dist.json $(find dist -name '*.html')
```

`bascik --check` covers Bascik syntax (component tags, props, slots, and scoping) and parses every built page against the WHATWG HTML spec. The optional `hint` command with `.hintrc.dist.json` checks the built pages with every hint on. Pass it files, not the `dist` folder: given a folder, webhint skips some hints, including `axe/text-alternatives`. If `directory.out` in `bascik.config` is not `dist`, use that folder in `find`. Lighthouse on the served build (`bascik --server`) checks the same head tags and accessibility rules in a browser.

Neither webhint config checks links: the `development` config has no hint for a broken link between local files. The `bascik` skill's `check-links.mjs` checks them.

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
  "elements": [
    "html5",
    { "img": { "attributes": { "src": { "required": false } } } }
  ],
  "rules": {
    "no-self-closing": "off",
    "element-required-content": "off",
    "empty-heading": "off",
    "wcag/h37": ["error", { "alias": ["data-bascik-attr-alt"] }]
  }
}
```

`no-self-closing` has no option for custom elements, so it is off in `src/`. The `elements` entry makes `src` optional on `<img>` only, so `element-required-attributes` still reports an `<html>` with no `lang`; it no longer reports an `<img>` with no `src` at all, which the root config still does on `dist/` (`npx html-validate "dist/**/*.html"`). `wcag/h37` counts `data-bascik-attr-alt` as an `alt` and still reports a literal `<img>` with neither.

HTMLHint, in `src/.htmlhintrc`. The HTMLHint VS Code extension reads the nearest one, and the `htmlhint` CLI finds it too when run as `npx htmlhint "src/**/*.html"`, so `--config` is needed only for a file kept somewhere else. HTMLHint does not merge a config file with its defaults: it runs only the rules the file lists, so a file with just the two exceptions turns every check off. List the default rules and set the two to `false`:

```json
{
  "tagname-lowercase": true,
  "attr-lowercase": true,
  "attr-value-double-quotes": true,
  "doctype-first": false,
  "tag-pair": true,
  "spec-char-escape": true,
  "id-unique": true,
  "src-not-empty": true,
  "attr-no-duplication": true,
  "title-require": false
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
  "words": ["bascik", "okafor"]
}
```

## More Webhint Settings

These are not Bascik exceptions, but projects often add them to `.hintrc`:

```json
{
  "hints": {
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

If you choose Webhint for CI, copy `.hintrc.dist.json` above and run it on the built pages next to Bascik's own checks. This optional example uses `npx` rather than adding a project dependency:

```json
{
  "scripts": {
    "check:standards": "bascik --build && npx hint -c .hintrc.dist.json $(find dist -name '*.html')"
  }
}
```

```sh
npx bascik --check && npm run check:standards
```

`$(find ...)` needs a POSIX shell (macOS, Linux, Git Bash, or WSL). On Windows `cmd`, list the files or run Lighthouse instead. Use your `directory.out` folder in place of `dist` if you changed it.

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
