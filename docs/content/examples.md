# Examples Overview

Working components and a complete site to copy into your project and change. They are examples, not a component library: there is nothing to install or upgrade, and once copied they are your files.

Every example works with several instances on one page, passes `bascik --check` and the [linter](/tools/linter), and is tested in a browser on every change. The files live in the [`examples/` folder](https://github.com/bascikdev/bascik/tree/main/examples) of the Bascik repository, and these pages read them directly, so what you see here is what you copy.

## Components

| Example | Shows |
|---|---|
| [Tab Group](/examples/tab-group) | Tabs from slotted sections, arrow keys, runtime ARIA IDs that stay unique per instance |
| [Modal Dialog](/examples/modal-dialog) | Native `<dialog>`, backdrop click, scroll lock with `html:has()` |
| [Popover Menu](/examples/popover-menu) | A dropdown with no JavaScript, using `popover` and anchor positioning |
| [Copy Button](/examples/copy-button) | The Clipboard API with an announced result, and a prop bound to an attribute |
| [Filter List](/examples/filter-list) | Live filtering of slotted list items |
| [Contact Form](/examples/contact-form) | Validation, a JSON `fetch`, preserved field names, and the API route behind it |
| [Theme Toggle](/examples/theme-toggle) | Light and dark themes with no flash on load |

The [Kitchen Sink](/examples/kitchen-sink) puts two of every component on one page.

## Sites

The [Starter Site](/examples/starter-site) is a complete project: shared layout components, per-page SEO tags, a Markdown blog with tags and a feed, `llms.txt`, a contact page, and a 404 page. Take all of it or only the parts you need.

## Copy an Example

With the [agent skills](/tools/agent-skill) installed, `add-example.mjs` downloads an example from this site and writes each file to the folder your `bascik.config.ts` uses. It refuses to overwrite a file you changed and writes nothing when it would:

```sh
node .agents/skills/bascik/scripts/add-example.mjs --list
node .agents/skills/bascik/scripts/add-example.mjs tab-group
node .agents/skills/bascik/scripts/add-example.mjs starter-site/src/lib/seo.ts
node .agents/skills/bascik/scripts/add-example.mjs starter-site --dry-run
```

Copying part of the starter site also copies the example components that part uses. Configuration files (`bascik.config.ts`, `package.json`) are never copied: the script prints them so you can merge the settings by hand.

Without the skills, copy the files from GitHub. A component is one folder; drop it into `src/components/`.

## Change Them

Rename tags, restyle, and rewrite freely. Keep the scoping rules each example's "How It Works" section explains: find elements with `getElementById`, keep class names static, and derive runtime IDs from a scoped ID. Then check your version:

```sh
npx bascik --check
npx @bascik/language-server --check
```
