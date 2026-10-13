# Example Components

Working components to copy into your project and change. They are examples, not a component library: there is nothing to install or upgrade, and once copied they are your files.

Every component works with several instances on one page, passes `bascik --check` and the [linter](/tools/linter), and is tested in a browser on every change. The files live in the [`examples/` folder](https://github.com/bascikdev/bascik/tree/main/examples) of the Bascik repository, and these pages read them directly, so what you see here is what you copy.

## Components

| Component | Shows |
|---|---|
| [Site Header](/example-components/site-header) | A skip link and navigation that marks the current page at build time, with a page-aware build script |
| [Site Footer](/example-components/site-footer) | Links and a copyright year from a build script that runs once for the whole site |
| [Tab Group](/example-components/tab-group) | Tabs from slotted sections, arrow keys, runtime ARIA IDs that stay unique per instance |
| [Modal Dialog](/example-components/modal-dialog) | Native `<dialog>`, backdrop click, scroll lock with `html:has()` |
| [Popover Menu](/example-components/popover-menu) | A dropdown with no JavaScript, using `popover` and anchor positioning |
| [Copy Button](/example-components/copy-button) | The Clipboard API with an announced result, and a prop bound to an attribute |
| [Filter List](/example-components/filter-list) | Live filtering of slotted list items |
| [Contact Form](/example-components/contact-form) | Validation, a JSON `fetch`, preserved field names, and the API route behind it |
| [Theme Toggle](/example-components/theme-toggle) | Light and dark themes with no flash on load |

The repository also has a complete [starter site](https://github.com/bascikdev/bascik/tree/main/examples/starter-site) that uses these components: shared layout components, per-page SEO tags, a Markdown blog with tags and a feed, `llms.txt`, a contact page, and a 404 page.

## Copy a Component

With the [agent skills](/tools/agent-skill) installed, `add-example.mjs` downloads a component from this site and writes it to the first component folder in your `bascik.config.ts`. It refuses to overwrite a file you changed and writes nothing when it would:

```sh
node .agents/skills/bascik/scripts/add-example.mjs --list
node .agents/skills/bascik/scripts/add-example.mjs tab-group
node .agents/skills/bascik/scripts/add-example.mjs starter-site/src/lib/seo.ts
```

The script also copies files from the starter site, along with the example components they use. It prints configuration files (`bascik.config.ts`, `package.json`) instead of copying them, so you can merge the settings by hand.

Without the skills, copy the files from GitHub. A component is one folder; drop it into `src/components/`.

## Change Them

Rename tags, restyle, and rewrite freely. Keep the scoping rules each component's "How It Works" section explains: find elements with `getElementById`, keep class names static, and derive runtime IDs from a scoped ID. Then check your version:

```sh
npx bascik --check
npx @bascik/language-server --check
```
