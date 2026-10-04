---
title: Writing posts
description: Headings, links between posts, and highlighted code.
date: 2026-02-02
tags: [basics, markdown]
---
Posts are Markdown. A few things are handled for you at build time, and none of them ships JavaScript to the reader.

## Headings get anchors

Every heading from `##` down gets an `id` and a small `#` link, so you can point someone at one section. Hover or focus a heading to see its link. If two headings have the same text, the second becomes `heading-2`.

## Links between posts

Link to another post by its file path, as in [the welcome post](welcome.md), and the build rewrites it to the final address. A link to a file that does not exist, or to a draft, fails the production build instead of publishing a dead link. Add a fragment to land on a section: [the one rule](welcome.md#the-one-rule).

External links open normally, for example [the Bascik documentation](https://bascik.dev/).

## Code

Fenced blocks are highlighted by Prism while the site is built:

```js
// Count how many words a post has.
function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

console.log(countWords('A short sentence.'));
```

A block with no language is escaped and shown as plain text:

```
<script>alert('this is text, not a script')</script>
```

Long lines scroll sideways, and the block can be reached with the keyboard.

## Other Markdown

> A quotation is set apart with a left rule.

| Feature | Where |
| --- | --- |
| Front matter | top of the file |
| Body | everything after it |

Raw HTML in a post is passed through as written, so only publish text you wrote or trust.
