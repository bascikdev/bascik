---
title: Deploying
description: Build for your real address and upload the dist folder.
date: 2026-05-04
tags: [deploying]
---
The finished site is the `dist/` folder. It is static files, so any static host can serve it.

## Tell the build where the site lives

Canonical links, link previews, the Atom feed, `sitemap.xml`, and `robots.txt` all need the real address. Copy `.env.example` to `.env` and set `BASCIK_SITE_URL`, or set the same variable in your host's build settings:

```sh
BASCIK_SITE_URL=https://blog.example.com npm run build
```

Use an origin with no path. The template assumes the site is served from the root of its domain, so a project page such as `https://user.github.io/repo` is not supported as it is.

## Build and check

`npm run build` writes `dist/`. `npm run serve` serves it the way production will, which is the best place to look before you upload.

## What you get

- one page per post, tag, and archive page
- `404.html`, which most static hosts show for a missing address
- `feed/feed.xml`, `sitemap.xml`, and `robots.txt`

Nothing here has been checked on a particular host. Follow your host's instructions for static sites and point it at `dist/`.
