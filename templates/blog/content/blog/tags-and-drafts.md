---
title: Tags and drafts
description: Group posts with tags, and keep unfinished work out of the published site.
date: 2026-03-23
tags: [basics, drafts]
---
## Tags

Add `tags` to the front matter, either one tag or a list:

```yaml
tags: [basics, images]
```

Each tag gets a page at `/tags/<name>/` and an entry on the [tags page](/tags/). A tag becomes a web address, so `Field notes` is published at `/tags/field-notes/`. If two different tags would end up at the same address, such as `Notes` and `notes`, the build tells you instead of merging them.

## Drafts

Set `draft: true` and the post is visible only while you run `npm run dev`. It is marked "(draft)" in the lists. `npm run build` leaves it out of every page, the sitemap, and the feed, and its pictures are not copied either.

A published post cannot link to a draft. The build stops and names the link, because the link would break the moment the site is published.

There is one draft in this sample, `content/blog/next-up.md`. You see it in development and do not see it in the production build.
