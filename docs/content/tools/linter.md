# Linter

Bascik provides official linter and editor tooling to catch invalid markup, unclosed components, undeclared props, misplaced script directives, and CSS/JS scoping errors as you type or in CI.

Editor support and CLI diagnostics are powered by `@bascik/language-server`.

## Linter, or `bascik --check`?

Both, and they do different jobs. Each rule lives in exactly one of them.

|         | Linter (`@bascik/language-server`)                                                                                   | [`bascik --check`](/cli#static-analysis-with-bascik-check)                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Answers | Questions about **one file**: is this attribute a typo, can this CSS be scoped, does this API route export a handler | Questions about the **whole project**: duplicate routes, unused components, config errors, unmatched tags |
| Runs    | In your editor as you type, and from the command line                                                                | From the command line and CI                                                                              |
| Needs   | Nothing but the file (and the project's config, to find components)                                                  | The whole project                                                                                         |

`bascik --check` also runs the linter. When `@bascik/language-server` is installed, `bascik --check` hands it your pages, components, and API routes and lists what it finds, so one command covers both halves and an editor squiggle always matches what CI reports. The full list of which rule lives where is in [Diagnostics](/internals/diagnostics#where-each-rule-lives).

Use the linter on its own, without `bascik`, when you want per-file checks and nothing else: a shared component library with no site of its own, a pre-commit hook that must stay fast, or an editor other than VS Code.

## Features at a Glance

- **Component Autocompletion**: Auto-completes custom tags (`<my-counter />`, `<site-nav>`), automatically inserting self-closing tags for void components or slot blocks for components with slots.
- **Prop & Slot Completion**: Suggests declared and inferred props (`data-bascik-prop-*`) with descriptions and validates named slots (`data-bascik-slot`).
- **Script Directive Completion**: Contextually completes `data-bascik-build`, `data-bascik-build-once`, `data-bascik-routes`, `data-bascik-server`, and `data-bascik-stream` on `<script>` tags, enforcing mutual exclusion so you cannot accidentally combine conflicting script runtimes. Putting `data-bascik-build` and `data-bascik-build-once` on one tag is an error too: choose one build-script mode.
- **Hover Documentation**: Hovering over any custom component renders its `<!-- @bascik -->` docblock, author description, declared props, and available slot names.
- **Jump to Definition**: Jump directly from a custom tag to its HTML source file, or from a script import specifier (`@/...`, `./...`) to the target file.
- **Find All References**: List every page and component that uses a component, from one of its tags or from the component's own file. See [Find All References](#find-all-references).
- **Linter Diagnostics**: Instant feedback for unclosed components, paired closing tags on zero-slot components, and unscoped runtime DOM or CSS manipulations.

---

## CLI Linter

Every project scaffolded with `npm create bascik` includes a `lint` script in `package.json`. It runs [`bascik --check`](/cli#static-analysis-with-bascik-check), which hands your files to the linter and adds the project-wide checks:

```sh
npm run lint
```

Each finding gives the file, line and column, a rule name, and a suggested fix. This is a real run against a project with four problems planted in it:

![A terminal running npm run lint. It reports two warnings, an undeclared prop on site-header and an unclosed feat-card tag, and two errors, a data-bascik-build attribute on a div and a script with two conflicting directives. It ends with 2 errors, 2 warnings](/assets/demos/lint@2x.webp)

To run only the linter, without the project-wide checks, call the language server directly on any directory or file with `npx`:

```sh
npx @bascik/language-server --check
```

Check a specific path or page:

```sh
npx @bascik/language-server --check src/pages
```

Name several paths to check them in one run. The project is found from the first one, and an option the checker does not know, such as a misspelled `--fixx`, stops it with a usage error instead of being ignored:

```sh
npx @bascik/language-server --check src/components src/pages
```

The checker reads `bascik.config.ts` to know which folders hold components. A component folder outside the project, such as a monorepo's shared components, is not under the directory you check, so check it separately. Run from the site, the checker uses the site's config for any folder listed in its `directory.components`; `--project` names the project explicitly from anywhere:

```sh
cd sites/marketing
npx @bascik/language-server --check ../../shared/components
npx @bascik/language-server --check ../../shared/components --project .
```

### Auto-fixing with `--fix`

Add `--fix` to apply the fixes that have exactly one correct answer, write them to disk, and report what remains:

```sh
npx @bascik/language-server --check --fix
```

Two rules are fixable:

- `missing-prop-prefix`: `<my-card title="Hello">` becomes `<my-card data-bascik-prop-title="Hello">` when `title` is a declared prop of `my-card`.
- `prefer-self-closing-component`: `<zero-slot-comp></zero-slot-comp>` becomes `<zero-slot-comp />` when the component has no slots.

In VS Code, the same two fixes appear as Quick Fixes (`Cmd+.` or `Ctrl+.`) on the warning. `bascik --check --fix` applies exactly the same fixes, by calling this tool, so either command works in a pre-commit hook. The editor also offers **Wrap template in html\`...\`** for [`server-script-unescaped-markup`](#server-script-unescaped-markup), which `--fix` never applies (see below).

### `server-script-unescaped-markup`

In a `data-bascik-server` or `data-bascik-stream` script, a template literal that looks like markup (it holds a tag) and interpolates a value without [`html`](/html-helpers) is a warning on that hole:

```text
src/pages/search.html:14:31 - warning: (server-script-unescaped-markup) This markup template (line 14) interpolates ${q} (hole 1) without html. Wrap the template in html`...` from @bascik/bascik/html, which escapes each value for where it lands.
```

A value is fine without `html` when it is:

- a string, number, boolean or `null` literal;
- a number: `x.length`, `price.toFixed(2)`, a whole `Number(q)`, `parseInt(q, 10)` or `Math.round(q)` call, or arithmetic with `-`, `*`, `/`, `%` or a unary sign (`a * 2 - b`, `-x`);
- a `+` whose operands are all fine (`count + 1`, `items.length + 1`, `"Hi " + esc(q)`), or a loop counter plus a number (`i + 1`) when the name is not bound to a value that is not fine;
- an `ALL_CAPS` constant;
- a nested `html` value, such as ``items.map((i) => html`...`)``;
- a call to `html`, `raw`, `esc`, `safeUrl`, or `json` as imported from `@bascik/bascik/html` (aliases and namespace imports count), or to a function listed in `diagnostics.escapeFunctions`;
- a conditional (`?:`, `||`, `??`, `&&`) whose rendered operands are fine, or a name bound to one of these.

These are reported, because `+` joins strings and a joined string can carry a visitor's markup:

- `${first + last}` and `${name + ": $" + price.toFixed(2)}`: `toFixed()` makes only its own operand a number;
- `${q + 1}` when `q` holds request data, and `${Number(x) || name}`, where `name` can render;
- a `let` or `var` name reassigned after its declaration: every later `name = ...`, `name += ...`, `name ||= ...` or `name ??= ...` counts, so `let label = "everyone"; if (q) label = q;` is reported where `${label}` lands. A `const` is checked by its one value.

Templates tagged with `String.raw`, `dedent`, `outdent`, `stripIndent`, `stripIndents`, `oneLine`, `oneLineTrim` or `codeBlock` join their values as they are, so they are checked like templates without a tag (with no quick fix, since the fix would replace a tag). Other tagged templates (`` sql`...` ``, `` css`...` ``, a project's own tag) are skipped, because a tag may escape its values. Templates that hold no tag (URLs, SQL, JSON, plain text), and the arguments of `console.*()`, `new Error()` and `throw`, are skipped, and so are the sink rules on them: `WHERE id = ${id}` in a SQL template is not an unquoted attribute. A hole where `html` would throw (an `onclick` value, a `<script>` body, a `style`, an unquoted attribute) keeps its own sink warning instead.

The quick fix **Wrap template in html\`...\`** puts `html` before the backtick and adds `import { html } from "@bascik/bascik/html";` after the script's last import, or merges `html` into an existing import from that module. When the name `html` already means something else in the script's code (a variable, a parameter such as `(title, html) => ...`, a function, another import), it imports `html as safeHtml` instead, merged into an existing import from the module when there is one, and tags with `safeHtml`. Words in strings, comments and markup (`<html>`) and members such as `page.html` do not count. When `safeHtml` is taken too, the fix is not offered, so it never writes code that means something else.

The fix is also not offered when a hole of the template sits where `html` would throw, because the fixed page would fail on every request: a tag name (`<h${level}>`), where an attribute name goes (`<p ${attrs}>`), an unquoted value, inside an HTML comment or a `<!...>` declaration, inside a `<script>` or `<style>`, in an `on*`, `style` or `srcdoc` value, in a `<meta>` `http-equiv` or `content` value, or in an attribute of an SVG `<animate>`, `<set>`, `<animateMotion>` or `<animateTransform>`. A template that ends inside a tag, comment or quoted value gets no fix either. Nor is it offered when wrapping would escape a value twice:

- **A hand-written escaper.** A hole such as `${escape(q)}` or `${escapeHtml(q)}`, a call to a function named like an escaper that is not trusted, gets a longer message: `escape() looks like a hand-written escaper, and html escapes too, so wrapping this template in html would show &amp;lt; on the page.` Wrap the template in `html` yourself and pass the value as it is (`${q}`), or list the function in `diagnostics.escapeFunctions` if it is a trusted escaper.
- **A joined string.** A hole that is a `.join(...)` call, or a name bound to one, holds markup already; wrapping the outer template would escape it. Wrap the inner templates in `html`, drop `.join("")`, and pass the array.

`bascik --check --fix` does not apply the quick fix: wrapping changes the template's value from a string to an `html` value, which can break code that calls `.replace()` or `.length` on it, so the change needs your eyes.

Inside `html` templates the sink rules become errors (`html` throws there), and two more rules catch values that would show as escaped markup:

- `html-escaped-twice` (info) reports `esc()` inside `html`, which shows `&amp;lt;` on the page.
- `html-joined-string` (warning) reports a `.join(...)` of `html` values, or a name bound to one, in a text hole: `This hole joins its items into one string, which html escapes, so the page shows &lt;li&gt; as text.` Pass the array without `.join("")`.

To trust a project escaper, list it in `diagnostics.escapeFunctions`. To silence a rule, put `// bascik-ignore server-script-unescaped-markup` on the line above the template's first line; it covers every hole in that template, including holes on later lines of a multi-line template. `bascik-disable` and `bascik-enable` comments silence a range, and `diagnostics.disabledRules` turns a rule off for the project. See [Security](/security#the-linter).

![VS Code: a server script returns a template that interpolates a query parameter, the hole is underlined, the hover names server-script-unescaped-markup, and the quick fix wraps the template in html and adds the import](/assets/vscode/unescaped-markup@2x.webp)

### `shared-name-group`

`name` ships as written ([Component Best Practices](/component-best-practices#name-form-controls-and-groups)), so a component that holds a whole name group makes one group of all its copies on a page. The linter warns on the `name` attribute in the component file when the component is used more than once on one page and holds:

- two or more radios with one `name` that are not inside a `<form>` of the component's own (and have no `form` attribute): the copies are one radio group, so choosing in one copy clears the others;
- two or more `<details>` with one `name`: the copies are one exclusive accordion;
- a `<map name>`: the page has one map name per copy, and every `usemap` uses the first.

```text
src/components/froth-picker/froth-picker.html:4:25 - warning: (shared-name-group) name="froth" is on 2 radios with no <form> of their own, and <froth-picker> is used 2 times on src/pages/index.html, so the copies act as one radio group on the page: choosing in one copy clears the others. Wrap the radios in the component's own <form>, or give each copy its own name through a prop: data-bascik-attr-name="group" in place of name here, and data-bascik-prop-group="..." with a different value on each <froth-picker>.
```

The two fixes: wrap the radios in the component's own `<form>`, or bind the name to a prop (`data-bascik-attr-name="group"` with no literal `name`, and a different `data-bascik-prop-group` on each usage). The rule stays quiet when the name is bound to a prop, when the radios are inside the component's own form, when the component is used once per page, for one radio or one `<details>` per component (a group built from many instances on purpose, such as an accordion with one item per component), and in a project that sets `scoping.attributes.name: true`. It counts usages on every page under `src` and the pages folder, through nested components and in unsaved editor text; pages built from Markdown or by a build script are not counted.

When the shared group is what you want, silence it on the line above the attribute, or around the markup:

```html
<!-- bascik-ignore shared-name-group -->
<details name="faq">
  <summary>Shipping</summary>
  Two days.
</details>
<details name="faq">
  <summary>Returns</summary>
  Thirty days.
</details>
```

`bascik-ignore` covers its own line and the next, so for a group spread over many lines use `<!-- bascik-disable shared-name-group -->` and `<!-- bascik-enable -->`, or turn the rule off for the project with `"disabledRules": ["shared-name-group"]` in `bascik.ext.json`.

### Hints: `attr-prop-unsupplied` and `api-unguarded-json`

Two rules are hints: advice that is easy to ignore and never fails a run.

- `attr-prop-unsupplied` marks a `data-bascik-attr-*` binding in a component whose prop no usage supplies: no page, no other component, and no open editor buffer has a `<my-card data-bascik-prop-href="...">` for `data-bascik-attr-href="href"`. It cannot see usages written in Markdown or produced by a build script, which is why it is a hint.
- `api-unguarded-json` marks a `request.json()` (or `req.json()`) call in an API route that is not inside a `try` block, because a malformed body then throws and the route answers 500.

Silence either with its id, like any rule: `<!-- bascik-ignore attr-prop-unsupplied -->` or `// bascik-ignore api-unguarded-json` on the line above, or `"disabledRules": ["attr-prop-unsupplied"]` in `bascik.ext.json`.

### CI / Pre-commit Integration

The CLI checker exits with code `0` when clean (or only warnings) and code `1` when errors are detected, making it drop-in ready for GitHub Actions or pre-commit git hooks. Hints are shown in the editor and by this command, and never fail anything:

```yaml
- name: Lint Bascik components and scripts
  run: npx @bascik/language-server --check
```

---

## Editor Setup

In every editor, the language server checks only folders that are Bascik projects: a folder with a `bascik.config.*`, a language server config at its root (`bascik.ext.json`, `.bascikrc.json`, `bascik.ext.ts`, or `bascik.ext.js`), or a `package.json` that lists `@bascik/bascik` or `@bascik/language-server` in any dependency field. A shared component library that uses the linter on its own, or a global install with no `package.json` entry, opts in with a `bascik.ext.json`. Any other folder, such as a React or Vue app with its own `src/components`, gets no diagnostics, while navigation, hover, and completion still work, and the server logs why once (in VS Code, to the **Bascik** output panel). `--check` does not apply this rule: it checks the files you name in any folder.

### VS Code

Install the official **Bascik** extension from the VS Code Marketplace:

1. Press `Ctrl+P` (or `Cmd+P` on macOS).
2. Type:
   ```text
   ext install bascik.bascik-vscode
   ```
3. Press Enter.

New projects scaffolded with `create-bascik` include `.vscode/extensions.json`, prompting VS Code to recommend installing the extension upon opening the folder.

### Find All References

The server answers the standard `textDocument/references` request for components, so `Shift+F12` in VS Code, `vim.lsp.buf.references()` in Neovim, and any other editor's Find All References list every page and component that uses one. A request resolves on a component tag name, opening or closing, or on the first line, the `<!-- @bascik` comment, or the root element's tag line of the component's own file. Each result is the tag name in an opening tag, pages first, then components. A tag in a comment, an attribute value, or a `<script>`, `<style>`, or `<textarea>` body is not counted, matching what the compiler expands.

![VS Code: Shift+F12 on the @bascik comment of product-card.html opens Peek References listing the pages and components that use it](/assets/vscode/find-references@2x.webp)

> **Source files only.** The server reads your project's HTML files, so a usage that only exists in the output of a build script, a Markdown file, or a server script is not listed.

### Neovim (`nvim-lspconfig`)

Because Bascik implements the standard Language Server Protocol (LSP), you can use it in Neovim with `nvim-lspconfig`:

```lua
local lspconfig = require('lspconfig')
local configs = require('lspconfig.configs')

if not configs.bascik then
  configs.bascik = {
    default_config = {
      cmd = { 'npx', '@bascik/language-server', '--stdio' },
      filetypes = { 'html' },
      root_dir = lspconfig.util.root_pattern('bascik.config.ts', 'bascik.config.js', 'bascik.ext.json', '.git'),
      settings = {},
    },
  }
end

lspconfig.bascik.setup{}
```

## Suppressing Warnings

### In-File Comments

To suppress a warning for a specific line:

```html
<!-- bascik-ignore -->
<inherit-demo-card></inherit-demo-card>
```

In CSS or JavaScript:

```css
/* bascik-ignore */
[data-state] {
  color: red;
}
```

```js
// bascik-ignore
element.id = "dynamic-id";
```

You can also disable checks across an entire block:

```html
<!-- bascik-disable -->
...
<!-- bascik-enable -->
```

Both `bascik-ignore` and `bascik-disable` accept a comma-separated list of rule ids, with or without spaces after the commas, to silence only those rules:

```js
/* bascik-disable js-attribute-selector, js-document-class-query */
```

### Configuration File (`bascik.ext.json`)

To configure diagnostics project-wide, create a `bascik.ext.json` or `bascik.ext.ts` in your project root:

```json
{
  "diagnostics": {
    "selfClosingComponents": false,
    "disabledRules": ["component-metadata-duplicate-annotation"],
    "escapeFunctions": ["escapeHtml"]
  }
}
```

A `bascik.ext.ts` or `bascik.ext.js` is read without running it, so it holds literal values only: `export default { ... }` (with `satisfies` after it if you like), `const config: BascikExtensionConfig = { ... }; export default config;`, or `module.exports = { ... }`. When a config file cannot be read (invalid JSON, a computed value, no default export), the language server ignores it and logs the file, line, and reason to the **Bascik** output panel, or to the terminal under `--check`.

`serverScriptRules: false` turns off every rule for server and stream scripts. `escapeFunctions` lists a project's own escaping functions, which `server-script-unescaped-markup` then trusts like `esc()`.

---

## Architecture Note (LSP)

Under the hood, `@bascik/language-server` is an implementation of Microsoft's **Language Server Protocol (LSP)**. This means the exact same analysis engine powers the command-line linter, the VS Code extension, and editor plugins for Neovim.
