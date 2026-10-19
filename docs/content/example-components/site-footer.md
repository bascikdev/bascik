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

- The footer is the same on every page, so its build scripts are plain `data-bascik-build`: each runs once for the whole site, and Bascik reuses the output on every page. Compare the [Site Header](/example-components/site-header), which needs `data-bascik-build="page"` because each page marks a different link.
- The year comes from a build script, so it is correct as of the last build. Rebuild at least once a year, or print it with a client `<script>` if the site is rarely rebuilt.
- The `<nav aria-label="Footer">` label keeps it distinct from the header's navigation for screen reader users.

## Adapt It

- For columns of links, return several labeled lists from `footerLinks()` and lay them out with a grid.
- To repeat the header's links, import them from `../site-header/links.ts`, or move one shared list to `src/lib/` and import it as `@/lib/links.ts`.
