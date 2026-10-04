---
title: Images and figures
description: Keep a post's pictures in its own folder and let the build check their sizes.
date: 2026-03-02
tags: [basics, images]
---
A post that has pictures lives in a folder named after it: `content/blog/images-and-figures/images-and-figures.md`. It is still published at `/blog/images-and-figures/`, and the pictures beside it are published at the same address.

## Add a picture

Write the usual Markdown image. Give it a title and it becomes a figure with a caption:

![A sunset over a small harbor, with a lamp on the near headland.](harbor.png "A harbor at dusk. Original artwork made for this template.")

The build reads the real width and height of the file and writes them on the image, so the page does not jump while the picture loads. Images below the top of the page are loaded lazily.

## Responsive sizes

Save smaller copies beside the original with the width in the name: `harbor-480w.png` and `harbor-960w.png` next to `harbor.png`. The build checks that each copy really has that width and the same shape as the original, then writes a `srcset` so a phone downloads the small file. If a copy has the wrong width or was cropped, the build stops and says which file.

No image library is needed. Resize with any tool you like, and keep the copies next to the original.

## A hero image

Add `image: harbor.png` to the front matter and the post gets a large image above its text, and the same file is used for link previews on social sites. Use `imageAlt` to describe it.
