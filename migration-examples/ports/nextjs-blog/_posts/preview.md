---
title: "A Color Scheme Switch Without a Framework"
excerpt: "One button cycles between system, dark, and light, remembers the choice, and applies it before the first paint."
coverImage: "/assets/blog/preview/cover.jpg"
date: "2024-03-04T09:00:00.000Z"
author:
  name: Lena Fischer
  picture: "/assets/blog/authors/lena.png"
ogImage:
  url: "/assets/blog/preview/cover.jpg"
---

The round button in the top corner of every page changes the color scheme. It starts by following your system setting. Each press moves to the next mode: dark, then light, then back to the system setting.

The choice is stored in the browser, so it survives a reload. Other open tabs of this site switch along with it.

## Avoiding a flash

A stored choice has to be applied before the page is painted. Otherwise a reader who chose dark sees a bright page for a moment first.

The switch therefore has two scripts. The first one sits at the very start of the page body and runs while the page is still loading. It reads the stored choice and sets the class on the root element straight away. The second one wires up the button once it exists.

## Styling the button

The button's styles live in a stylesheet next to the component. Its class names and its animation are renamed at build time, so they cannot collide with anything else on the page.
