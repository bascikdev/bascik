---
title: Customizing the site
description: Change the name, navigation, colors, and layout.
date: 2026-04-13
tags: [customizing]
image: /blog/images-and-figures/harbor.png
imageAlt: A sunset over a small harbor.
---
Most changes are in four places.

## Name, description, and navigation

`src/data/site.ts` holds the site title, description, language, author, the number of posts per page, and the navigation list. The header, the page titles, the feed, and the footer all read from it.

## Colors and type

`src/css/global.css` starts with a block of custom properties. Change `--color-link`, `--color-background`, and the fonts there, and the whole site follows, including the dark scheme further down.

## Layout

Pages are in `src/pages/`, and the shared header and footer are components in `src/components/`. The `<head>` of every page, with its title and sharing tags, comes from `renderHead()` in `src/lib/render.ts`. The code that turns Markdown into HTML is also in `src/lib/`. It is ordinary TypeScript, so read it and change it.

## Your own pages

Add a Markdown file to `content/` for a simple page, or an HTML file to `src/pages/` for a custom one. To add a page to the navigation, add it to the list in `src/data/site.ts`.

## Replace the sample

Delete the sample posts in `content/blog/` and the images in `content/blog/images-and-figures/`, and replace `content/about.md`. Put your own social card at `src/pages/assets/social-card.png` (1200 by 630 works well) and your own icon at `src/pages/assets/favicon.svg`.
