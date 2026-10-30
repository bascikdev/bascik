# Site Footer

A footer for every page: secondary links and a copyright line. The links and the year are written at build time, so the footer is plain HTML and ships no JavaScript.

[Source on GitHub](https://github.com/bascikdev/bascik/tree/main/examples/components/site-footer)

## Usage

`name` is the copyright holder and defaults to "Example Site".

<!-- demo:usage -->

```html
<site-footer data-bascik-prop-name="Example Site" />
```

<!-- example:demo -->

## links.ts

<!-- example:file components/site-footer/links.ts -->

## How It Works

- The footer is the same on every page, so both of its build scripts are [`data-bascik-build-once`](/build-scripts#data-bascik-build-once): each runs once, when Bascik registers the component, and every page shares the output. Compare the [Site Header](/example-components/site-header), whose `data-bascik-build` script reads `BASCIK_PAGE_PATH` to mark a different link on each page.
- The year comes from a build script, so it is correct as of the last build. Rebuild at least once a year, or print it with a client `<script>` if the site is rarely rebuilt. Build script output is cached, so add `src/components/site-footer/**` to `scripts.cache.exclude` to print a new year when no file changed.
- The `<nav aria-label="Footer">` label keeps it distinct from the header's navigation for screen reader users.

## Adapt It

- For columns of links, return several labeled lists from `footerLinks()` and lay them out with a grid.
- To repeat the header's links, import them from `../site-header/links.ts`, or move one shared list to `src/lib/` and import it as `@/lib/links.ts`.
