# Bascik blog template

A complete, customizable blog for [Bascik](https://bascik.dev/): Markdown posts, a paginated archive, tag pages, an Atom feed, canonical and Open Graph metadata, responsive images, syntax highlighting, drafts, and a 404 page. The site is static HTML and CSS. It ships no JavaScript to the browser.

The sample content ("Lantern Log") explains how each feature works. Replace it with your own.

## Requirements

- Node 24 or later
- A Bascik release with large route payload support and printed-directive removal.

## Start

```sh
npm ci --ignore-scripts
cp .env.example .env     # then set BASCIK_SITE_URL to your address
npm run dev              # development server with live reload; drafts are shown
npm run build            # production build into dist/
npm run serve            # serve dist/ the way production will
npm test                 # unit tests for the content pipeline
npm run typecheck
```

`npm run dev` works without a site URL. A production build needs one for canonical links, link previews, the feed, `sitemap.xml`, and `robots.txt`.

## What is where

| Path | What it is |
| --- | --- |
| `content/blog/` | Posts. `name.md`, or `name/name.md` when a post keeps images beside it |
| `content/about.md` | The About page, plain Markdown with no front matter |
| `src/data/site.ts` | Site title, description, language, author, navigation, posts per page |
| `src/css/global.css` | All styles. Colors and fonts are custom properties at the top |
| `src/pages/` | Page templates, including the dynamic routes for posts, tags, and archive pages |
| `src/components/` | The shared header and footer. The `<head>` is built by `renderHead()` in `src/lib/render.ts` |
| `src/lib/` | The content pipeline: posts, tags, pagination, Markdown, images, highlighting, HTML helpers |
| `scripts/` | Build steps that run around the page build: image copy and the Atom feed |
| `src/pages/assets/` | Files served as they are: the favicon and the default social card |
| `template.json` | Template metadata for tools that install this project |

## Write a post

Create `content/blog/my-post.md`:

```md
---
title: My post
description: One sentence for search results and link previews.
date: 2026-07-01
tags: [notes]
---
Text goes here.
```

`title` and `date` are required. `description`, `tags`, `draft`, `image`, and `imageAlt` are optional. Any other key is an error, so a typo such as `tag:` is caught instead of ignored. The file name becomes the address (`/blog/my-post/`) and may use lowercase letters, digits, and single hyphens.

Details for tags, drafts, links between posts, images, and responsive sizes are in the sample posts.

## Responsive images

Resize an image once and save the copies beside it, with the width in the name:

```text
harbor.png          1200 px wide (the original)
harbor-960w.png     960 px wide
harbor-480w.png     480 px wide
```

The build checks that every copy has the width in its name and the same shape as the original, then writes a `srcset`. A wrong width or a cropped copy fails the build and names the file. The template has no image library, so it cannot resize for you. If you want that, a build step using `sharp` can write the copies; the checks above will validate them.

## Settings

| Setting | Where |
| --- | --- |
| Site name, description, language, author | `src/data/site.ts` |
| Navigation | `NAV` in `src/data/site.ts` |
| Posts per archive page, home page count, feed length | `src/data/site.ts` |
| Site URL | `BASCIK_SITE_URL` (`.env`, an environment variable, or `--site-url`) |
| Colors, fonts, widths | custom properties at the top of `src/css/global.css` |

## Deploy

`npm run build` writes the whole site to `dist/`. Upload that folder to any static host, with `BASCIK_SITE_URL` set to the address the site is served from.

- Serve the site from the root of its domain (`https://blog.example.com/`). A URL with a path, such as `https://user.github.io/repo`, is rejected on purpose, because every internal link is root-relative.
- Configure the host to serve `404.html` for unknown addresses.
- The template needs no server, database, or runtime. `npm run serve` is a convenient check, not a requirement.

Nothing here has been verified on a specific hosting provider. Follow your host's static site instructions.

## Things to know

- Raw HTML in a post is passed through unchanged. Only publish text you wrote or trust.
- Dates are formatted in UTC, so a build gives the same result on any machine.
- With five or fewer posts, Bascik prints a warning that `src/pages/blog/page/[page]/index.html` produced 0 routes. That template creates archive pages 2 and up, so there is nothing for it to do yet.
- Pages and components run on every build because they read `content/`. This is set in `bascik.config.ts`.
- Heading anchors use CSS anchor positioning. In a browser without it the `#` link is still reachable, but sits after the heading instead of beside it.

## License and notices

MIT. See `LICENSE`. The sample images, the favicon, and the sample text are original to this template. Dependencies keep their own licenses. See `NOTICE.md`.
