# Overview

Use Cases show how to build a particular kind of site with Bascik, from the page structure and content workflow to the build and deployment. Each guide explains the architecture first, then links to a starter you can install when one exists.

## How the guides work

- **A guide** explains one kind of site: which pages it needs, how content gets in, how it builds, and what to customize. It is useful even if you never install the starter.
- **A starter** is a complete, runnable project that follows its guide. During prerelease testing, install one with `npm create bascik@rc my-site -- --example <name>`.
- **The [Template Catalog](/use-cases/templates)** lists every starter with screenshots, version, license, source, and requirements.

A guide appears in the navigation only when its starter exists and has been built and tested. The architecture is described separately from template availability, so a guide never promises a starter that is not there.

## Available now

| Site type | Guide | Starter |
| --- | --- | --- |
| Blog | [Blog](/use-cases/blog) | `blog`, in the [Template Catalog](/use-cases/templates#blog) |

## What a starter has been checked for

Each starter is installed in a clean copy, built, and run in the same modes you will use: the development server, the static build, and the production server. The checks cover the generated pages and links, the feed and sitemap, adding, editing, and deleting content, and the minified production output in a real browser at desktop and phone widths, including keyboard navigation.

Automated checks do not replace your own review. They do not show that a site is accessible to every reader, they do not test screen readers, and they do not cover any particular hosting provider. Each guide lists what was not checked.

## Building a site type that has no starter

Bascik has no content collections, template language, or plugin system. A content site is ordinary TypeScript that reads files and returns HTML, called from build scripts. These pages cover the pieces:

- [Dynamic Routes](/dynamic-routes) turn one page template into a page per post, tag, or archive page.
- [Build Scripts](/build-scripts) read your content and print HTML at build time.
- [Exec Scripts](/exec-scripts) write files that are not pages, such as a feed or copied images.
- [Markdown](/how-to/markdown) shows how to render Markdown with your own build script.
- [Watch Paths](/watch-paths) explains how the development server notices content changes.
- The [Astro Blog Tutorial](/switch/astro-blog-tutorial) and the [Eleventy Blog Tutorial](/switch/eleventy-blog-tutorial) walk through two complete blog ports in detail.
