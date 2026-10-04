---
title: "Pages That Are Finished Before Anyone Asks"
excerpt: "Static generation does the work once at build time, so every visitor gets the same complete page straight from the server."
coverImage: "/assets/blog/hello-world/cover.jpg"
date: "2024-03-11T09:00:00.000Z"
author:
  name: Ravi Okafor
  picture: "/assets/blog/authors/ravi.png"
ogImage:
  url: "/assets/blog/hello-world/cover.jpg"
---

A static page is a file. It was written during the build, it sits in the output folder, and the server sends it unchanged. There is no rendering step between the request and the response.

That makes these pages quick to serve and easy to cache. It also means they cannot change per visitor. Anything personal belongs in a small script on the page or in a request handler on the server.

## Where the content comes from

The posts are Markdown files with a block of front matter at the top. A build script parses the front matter, checks that every required field is present, and turns the Markdown into HTML.

If a post is missing its date or its cover image, the build stops and names the file. A broken post never reaches the site.

## What the browser receives

The browser receives HTML, one stylesheet, and the few lines of script that run the color scheme switch in the corner. Everything else on this page arrived as plain markup.
