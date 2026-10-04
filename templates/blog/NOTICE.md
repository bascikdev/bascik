# Notices

## Template code

The code in this folder is MIT licensed (see `LICENSE`).

It is derived from the Bascik port of the official Eleventy base blog (`migration-examples/ports/eleventy-blog`), which adapts structure, CSS rules, and behavior from `11ty/eleventy-base-blog`, commit `94bd3b7`. The upstream notice is retained below, as the upstream license requires.

```
MIT License

Copyright (c) 2017–2024 Zach Leatherman @zachleat

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Adapted from that project: the heading-anchor markup and its CSS approach, and the post-list and previous/next structure. Written for this template: Markdown handling, front matter validation, pagination, metadata, responsive images, the feed, and all content.

## Original material

The sample posts, `content/about.md`, the images in `content/blog/images-and-figures/`, `src/pages/assets/social-card.png`, and `src/pages/assets/favicon.svg` were written or generated for this template and are released under the same MIT license. No third-party photographs, fonts, or icons are included. Pages use the visitor's system font stack.

## Syntax highlighting theme

Code block colors come from `prismjs/themes/prism-okaidia.css`, which `src/lib/render.ts` reads from the installed `prismjs` package (MIT) at build time. Nothing from that theme is copied into this folder.

## Dependencies

Runtime and build-time packages are installed from npm and keep their own licenses: `@bascik/bascik`, `feed`, `gray-matter`, `image-size`, `marked`, `prismjs`, `zod`. Development only: `typescript`, `vitest`, `@types/node`, `@types/prismjs`.
