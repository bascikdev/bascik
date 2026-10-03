---
title: 'Components in Markdown'
description: 'How a Bascik component sits in the middle of rendered Markdown.'
pubDate: 2024-06-01
heroImage: '/assets/post-5.webp'
---

The original post demonstrates MDX, which lets a component appear between paragraphs of Markdown.
Bascik has no MDX. This port renders the Markdown first, and the HTML it produces may contain
component tags, which Bascik expands in its next pass.

## Why Markdown with components?

Markdown covers prose well, and a component covers anything that needs structure, styling, or
behavior. Keeping them in one file lets an author place a widget exactly where it belongs in the text.

## Example

Here is how a component appears inside a Markdown file. When you open this page in the browser, you
should see the clickable link below.

<menu-link href="#" onclick="alert('clicked!'); return false;">Embedded component in Markdown</menu-link>

## More Links

- [Markdown guide](https://www.markdownguide.org/basic-syntax/)
- [Bascik build scripts](https://bascik.dev/build-scripts)
- **Note:** Interactivity is plain HTML and JavaScript here. There is no hydration step.
