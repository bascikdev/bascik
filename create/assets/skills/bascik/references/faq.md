# FAQ

**How is Bascik pronounced?** Like "basic." The spelling comes from the creator's grandmother's maiden name. Bascik was created by Collin Thomas.

**What happens if a component is named after a native element, such as `nav.html`?**
Bascik warns and still loads it, then replaces every `<nav>` on the page with the component, which almost always breaks the site. Use a hyphenated name such as `site-nav.html`.

**What about uppercase letters in a file name, such as `My-Card.html`?**
Names are lowercased on load, so it registers as `<my-card>`. If two files differ only by case, the last one loaded wins. Always use lowercase.

**What if a page references a component that does not exist?**
The build warns with the unresolved tag name and ships the tag unchanged; it does not fail. `bascik --check` reports it as a warning (exit 0) so third-party custom elements such as `<model-viewer>` pass. Declare those in `components.external`, and use `--strict` to make warnings fail CI.

**Does Bascik need Web Components or Shadow DOM?**
No. Components are expanded at build time into plain HTML. The output works in every browser.

**Can I use React, Vue, or Svelte components?**
No. Bascik components are HTML files. Runtime libraries such as petite-vue, Alpine.js, or HTMX can enhance the HTML Bascik produces.

**How does Bascik compare to other tools?**
Svelte compiles to a JavaScript runtime for reactive DOM updates; Bascik compiles to plain HTML. Eleventy, Hugo, and Jekyll center on content pipelines and template languages; Bascik centers on component composition with no template language. HTMX and Alpine.js add runtime behavior and compose cleanly with Bascik.

**Are builds deterministic?**
Yes. Instance IDs derive from the page path, component name, and position, so repeated builds are byte-identical.

**Where does Bascik keep internal build files?**
In dot-prefixed paths such as `dist/.bascik/manifest.json` (when `generate.manifest` is on) and `dist/.bascik/server-scripts.json`. Requests containing a dot segment return 404, so these are never served. The one public dot-directory is a top-level `/.well-known/`, published from `src/pages/.well-known/`.

**Why do I see "variable already declared" errors in my editor?**
The editor treats every `<script>` in the file as one scope. Bascik wraps each block in its own IIFE, so the errors are false. Set `"html.validate.scripts": false` in `.vscode/settings.json`.

**Do I need to restart the dev server after adding a component?**
No. New components and pages are picked up automatically. Only `bascik.config.ts` changes need a restart.

**Can a 500 page be used in a static build?**
No. Static hosts serve their own error pages. `src/pages/500.html` is used only by `bascik --server`.
