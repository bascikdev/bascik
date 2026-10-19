# Site Header

A header for every page: a skip link, the site name, and the main navigation. The navigation is plain HTML written at build time, and the link for the current page is marked with `aria-current`, so the header needs no JavaScript.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/site-header)

## Usage

`name` is the site name and defaults to "Example Site". Anything inside the tag goes at the end of the bar, for example a [Theme Toggle](/example-components/theme-toggle). Every page needs a `<main id="main">` for the skip link to land on.

<!-- demo:usage -->

```html
<site-header data-bascik-prop-name="Example Site" />
```

<!-- example:demo -->

The links point at the paths in `links.ts`, which are pages of your site, not of this one, so none is marked in this preview. Press Tab at the top of a page that uses it to see the skip link.

## links.ts

The navigation lives in a TypeScript file next to the component. Edit the list for your site.

<!-- example:file components/site-header/links.ts -->

## How It Works

- The build script inside `<nav>` imports `./links.ts`. Relative imports in a component's script resolve from the component's folder, so the component and its data travel together.
- A build script in a component normally runs once, and its output is reused on every page. `data-bascik-build="page"` runs it again for each page with `BASCIK_PAGE_PATH` set to that page's path, so each page marks its own link: `aria-current="page"` on the page itself, and `aria-current="true"` on the section it belongs to (Blog on a blog post). See [Page-Aware Scripts](/how-to/page-aware-scripts#page-aware-component-scripts).
- Markup a build script prints is scoped like the component's template, so `.nav-list a` in the component's CSS matches the printed links.
- The skip link targets `#main`. No element in the component has that ID, so Bascik leaves the reference unscoped and it finds the `<main>` on the page.
- `<div data-bascik-slot></div>` is replaced by whatever you put inside the tag, or by nothing.

## Adapt It

- To share one list between the header and other places, move `links.ts` to `src/lib/` and import it as `@/lib/links.ts`.
- On small screens the links wrap. For a collapsed menu, put the list inside a [Popover Menu](/example-components/popover-menu) and show it inline above a breakpoint.
