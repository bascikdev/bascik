---
title: "One Template, Many Pages"
excerpt: "A single bracketed file name turns a folder of Markdown into a page per post, with no client router and no generated page files."
coverImage: "/assets/blog/dynamic-routing/cover.jpg"
date: "2024-03-18T09:00:00.000Z"
author:
  name: Ada Brennan
  picture: "/assets/blog/authors/ada.png"
ogImage:
  url: "/assets/blog/dynamic-routing/cover.jpg"
---

Every post on this site comes from one template. The file is named with square brackets around the part of the address that changes, and a short script lists the values that part can take. The build reads that list once and writes one finished page for each entry.

Nothing here runs in the visitor's browser. When you open a post, the server sends a page that was complete before you asked for it.

## Listing the routes

The routes script reads the posts folder and prints a small JSON array. Each entry names the value for the bracketed segment. Add a Markdown file and the next build has one more page. Remove one and its page is gone.

- The script runs in Node, so it can read files, call an API, or query a database.
- Each entry can carry extra data for the page that renders it.
- A segment cannot contain a slash. Use one template per depth instead.

## Rendering one post

The same template holds a second script that runs once per route. It reads the route values from an environment variable, loads the matching file, and prints the finished markup in place.

### Escaping

Anything printed into the page is escaped first, so a title with an ampersand or an angle bracket stays text.
