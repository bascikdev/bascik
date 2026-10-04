# Notices

This directory is a Bascik port of the official Eleventy base blog. It adapts code from the sources
below. Their notices are retained as required. All sample content and the image in this port are
original and are not taken from the upstream project.

## Eleventy base blog (MIT)

Source: `11ty/eleventy-base-blog`, commit `94bd3b7`.
Adapted: page structure, template structure, CSS rules, and behavior.

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

## Syntax highlighting theme

The code block colors come from `prismjs/themes/prism-okaidia.css`, which `src/lib/render.ts` reads
from the installed `prismjs` package (MIT, a declared dependency) at build time, as the upstream
project does. Nothing from that theme is copied into this directory. Token markup is also produced
at build time by `prismjs`.

## Original material

The Markdown posts, the image `content/blog/fourthpost/lighthouse.png`, and the about page text were
written or generated for this port. The upstream pretty-feed stylesheet carries no license and is
not copied.
