---
title: Hello, world
description: The first post on the new site, and how this blog is put together with Bascik.
date: 2026-01-15
tags: [news, bascik]
---

This site is plain HTML built by [Bascik](https://bascik.dev). Each post is a Markdown file in `content/posts/`.

## How it works

- `src/lib/posts.ts` reads and validates every post.
- `src/pages/blog/[slug]/index.html` turns each one into a page.
- `scripts/feed.ts` writes the Atom feed after the build.

> Replace this post with your own, or delete it.
