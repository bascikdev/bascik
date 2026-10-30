# Bascik Examples

Example components and an example site to copy into your own Bascik project and adapt. They are not a component library: there is no package to install and no API to keep stable. Each example is tested with the real compiler and in a browser, by the docs workspace (`docs/scripts/examples.integration.test.ts` and `docs/e2e/`).

- `components/`: standalone components (tabs, dialog, menu, copy button, filter list, contact form, theme toggle). The docs site renders every one of them.
- `starter-site/`: a complete site that uses them ([its README](starter-site/README.md)), with layout components, SEO helpers, a blog, and a feed.

Browse them at https://bascik.dev/example-components. To copy one into a project:

```sh
node .agents/skills/bascik/scripts/add-example.mjs --list
node .agents/skills/bascik/scripts/add-example.mjs tab-group
```
