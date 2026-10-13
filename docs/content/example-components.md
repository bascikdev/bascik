# Example Components

Working components that show how Bascik features fit together in real code. They are examples to read and learn from, not a component library: there is nothing to install or upgrade.

Every component works with several instances on one page, passes `bascik --check` and the [linter](/tools/linter), and is tested in a browser on every change. The files live in the [`examples/` folder](https://github.com/bascikdev/bascik/tree/main/examples) of the Bascik repository, and these pages read them directly, so what you see here is the real source.

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

## See a Technique in Use

Other pages explain a feature; these components show it inside something complete.

| To see this | Read | In this example |
|---|---|---|
| Per-instance IDs for scripts and ARIA | [Scoped JavaScript](/scoped-javascript) | [Tab Group](/example-components/tab-group), [Filter List](/example-components/filter-list) |
| Reading slotted content | [Slots](/slots) | [Tab Group](/example-components/tab-group), [Filter List](/example-components/filter-list) |
| A prop in an attribute | [Props](/props) | [Copy Button](/example-components/copy-button) |
| Design tokens with fallbacks | [Scoped Styles](/scoped-styles) | Every component |
| `html:has()` and anchor positioning | [Scoped Styles](/scoped-styles) | [Modal Dialog](/example-components/modal-dialog), [Popover Menu](/example-components/popover-menu) |
| Page-aware and once-per-site build scripts | [Page-Aware Scripts](/how-to/page-aware-scripts) | [Site Header](/example-components/site-header), [Site Footer](/example-components/site-footer) |
| Preserved field names and an API route | [Preserve Scoping](/preserve), [API Routes](/api-routes) | [Contact Form](/example-components/contact-form) |
| Light and dark themes | [Theming](/how-to/theming) | [Theme Toggle](/example-components/theme-toggle) |

The previews on these pages sit on a plain page background with the starter site's design tokens, so each component looks as it does in a real site. Each component reads its colors from tokens with neutral fallbacks, so it also works in a project with no token stylesheet.

The repository also has a complete [starter site](https://github.com/bascikdev/bascik/tree/main/examples/starter-site) that uses these components: shared layout components, per-page SEO tags, a Markdown blog with tags and a feed, `llms.txt`, a contact page, and a 404 page. The [agent skills](/agent-skills) use the examples and the starter site as reference when an assistant builds a Bascik project.

## Reading an Example

Each page shows the live component, how to use it, its full source, and a "How It Works" section that explains the scoping rules it relies on: find elements with `getElementById`, keep class names static, and derive runtime IDs from a scoped ID. Open the Source tab on any preview to see the component file.
