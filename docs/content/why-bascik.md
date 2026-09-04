# Why Bascik

Bascik is a build tool for HTML components with automatically scoped CSS and JS. Zero runtime. The code that ships is the code you wrote.

The guiding principle behind Bascik is simple: use what already exists. Do not invent new syntax, do not add a runtime, do not get in the way. Modern HTML, CSS, and JavaScript are enough. Be fast. Be transparent.

## See it in action

Create one HTML file, then use its filename as a tag anywhere, with no registration, imports, or framework API.

<!-- demo:source-usage -->
```html
<!DOCTYPE html>
<html lang="en">
<body>
  <hello-card />
</body>
</html>
```

<!-- demo:source-html -->
```html
<article class="hello-card">
  <p class="hello-card-kicker">One file. One tag.</p>
  <h3 class="hello-card-title">Plain HTML, ready to reuse.</h3>
  <p class="hello-card-body">
    Bascik replaces the custom tag at build time and ships the finished markup.
  </p>
</article>
```

<!-- demo:source-css -->
```css
.hello-card {
  padding: 24px;
  background: #242628;
  border: 1px solid #3a3d40;
  border-top: 3px solid #d3ff8d;
}
```

<!-- demo:output-html -->
```html
<!-- dist/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <style>
    .bascik__hello-card__hello-card {
      padding: 24px;
      background: #242628;
      border: 1px solid #3a3d40;
      border-top: 3px solid #d3ff8d;
    }
  </style>
</head>
<body>
  <article class="bascik__hello-card__hello-card">
    <p class="bascik__hello-card__hello-card-kicker">One file. One tag.</p>
    <h3 class="bascik__hello-card__hello-card-title">Plain HTML, ready to reuse.</h3>
    <p class="bascik__hello-card__hello-card-body">
      Bascik replaces the custom tag at build time and ships the finished markup.
    </p>
  </article>
</body>
</html>
```

## The Problem Bascik Solves

You've been here. You're building a straightforward site and you've copy-pasted the same navigation markup into every page for the third time. You Google _"how to reuse HTML on multiple pages without a framework"_ or ask ChatGPT _"HTML components without React."_ The answers are always the same: Web Components (verbose, requires JavaScript to render), server-side includes (awkward, server-dependent), or a full framework (React, Vue, Astro) that feels like enormous overkill for something this simple.

Building a website has never been simpler at the language level. HTML structures content, CSS styles it, JavaScript animates it. Every browser speaks all three fluently. Developers have spent thirty years learning them, and documentation is exhaustive.

The problem is organization, not language. Once a project grows past a handful of pages, copy-pasting the same navigation markup into every file becomes painful. Styles that were meant to be local start bleeding across the page. Script variables in one section collide with variables in another.

Frameworks like React and Vue solve this problem well, for interactive applications that genuinely need component state, client-side routing, and reactive data binding. Most websites are not that. A marketing site, a documentation portal, a portfolio, a blog, an account dashboard, these are mostly static documents with a handful of interactive moments sprinkled in. Reaching for a full framework for these projects means paying the runtime cost, the build complexity, and the mental overhead of an entire abstraction layer when the underlying platform already has everything needed.

> Frameworks were built for people writing large interactive applications. Bascik was built for everyone else, and for the tools that write code on their behalf.

## The Component Convention

In Bascik, creating a component is creating a file. Name a file `my-nav.html` and it becomes the `<my-nav>` tag, automatically, everywhere. There is no registration step, no import statement, no export, no class to define. The filename is the entire interface.

CSS inside that file scopes itself to that component. Write `.card { padding: 20px; }` and Bascik rewrites it to something like `.bascik__my-card__card { padding: 20px; }` at build time. You never manage a namespace. You never worry about a class name colliding with another component. You write CSS the way you always have, it just works.

JavaScript inside that file scopes itself too. Write `document.getElementById('count')` and Bascik rewrites it to target the scoped version of that element, so two instances of the same counter on one page stay completely isolated, not through Shadow DOM or any runtime trick, but because the selectors were rewritten before the browser ever saw them. TypeScript works here as well; `bascik.config.ts`, build scripts, and helper modules all run natively on Node 22.18+ with no compiler step.

> Create a file. Use the tag. Everything inside it, HTML, CSS, JavaScript, stays contained. No imports. No exports. No configuration. Use what you know, and use what the browser knows.

## The Platform Caught Up

There is a historical pattern worth recognizing. A language or platform ships without a feature the community needs. Someone builds a library to fill the gap. The library becomes ubiquitous. Years later, the platform ships the feature natively, but the ecosystem keeps reaching for the library out of habit.

jQuery filled a gap when DOM APIs were inconsistent across browsers. Underscore and Lodash filled a gap when JavaScript lacked functional array utilities. Tailwind filled a gap when organizing CSS at scale was genuinely hard. All of those tools were the right answer for their moment.

That moment has passed. Browser DOM APIs are consistent and capable. JavaScript ships with `Array.map`, `Array.filter`, `Object.assign`, optional chaining, and everything Lodash offered for free. CSS ships with custom properties, cascade layers, container queries, `:is()`, `:has()`, and logical properties. The platform caught up.

The only gap that remains is component organization, a way to write a navigation bar once and reuse it across pages without a runtime. That is the gap Bascik fills, using a build step rather than adding to the runtime.

## Why Not Web Components?

Web Components are a browser-native component model, and they are a legitimate answer to the organization problem. But they come with trade-offs that make them a poor fit for statically rendered sites.

Every Web Component requires JavaScript to be parsed, evaluated, and registered before the component renders. On a page with ten components, that is ten class definitions loading at runtime just to display static content. Search engines, accessibility tools, and users on slow connections all pay that cost.

Web Components also introduce a non-trivial API surface: custom element registries, shadow DOM, light DOM, lifecycle callbacks, slot distribution rules. For a developer writing a navigation bar, none of that is relevant. It is framework complexity without the framework ecosystem.

Bascik takes a different position: run the component resolution at build time, ship vanilla HTML. A `<site-nav>` tag in source becomes a `<nav>` element in the output. **Zero JavaScript is added to your pages.** Every script in the final HTML was written by you.

## Bascik and AI

Bascik was built before large language models became capable coding tools. As they advanced, something interesting became clear: AI is a better fit for Bascik than it is for most frameworks.

Language models were trained on the entire history of the web. They know HTML, CSS, and JavaScript exceptionally well, not just the syntax, but the patterns, the semantics, the accessibility attributes, the browser quirks. They can write assembly if asked. Writing a navigation component in HTML is trivial.

Frameworks introduce a layer the model has to reason through in addition to the underlying platform. To build a navigation component in React, the model must know React's component model, JSX syntax, hooks, prop types, and the conventions of the specific project setup, and then it must also know HTML, CSS, and the browser APIs that sit underneath. Every abstraction is another surface where the model can make a mistake, produce outdated patterns, or hallucinate an API that does not exist.

With Bascik, the model writes HTML, CSS, and JavaScript, three languages it knows precisely, with exhaustive documentation and decades of examples. Scoping and component resolution happen at build time without the model needing to understand any custom runtime. The component format is close enough to vanilla HTML that the model rarely needs to consult any Bascik-specific documentation at all.

> AI can write assembly. It does not need a framework to write a button. It needs a way to organize that button so it is reusable, maintainable, and ships as fast HTML. That is Bascik.

## Bascik and Other Libraries

Bascik is not exclusionary. It solves one problem, component organization at build time, and deliberately does nothing else. Everything else you might want on top of your HTML is still available to you.

Because Bascik's output is vanilla HTML, any library that works with HTML works with Bascik. [Petite Vue](https://github.com/vuejs/petite-vue) can mount reactive islands on the page. [Alpine.js](https://alpinejs.dev) can handle dropdowns and toggles. [HTMX](https://htmx.org) can fetch partial HTML from a server. Any chart library, animation library, or analytics script drops straight in with a `<script>` tag, because that is all it takes to load a library into a vanilla HTML page.

This is the opposite of a full-stack framework, which tends to control the entire rendering pipeline and make integrating outside tools awkward. Bascik controls nothing at runtime. It hands you finished HTML and steps aside. What you do with that HTML, whether you add Alpine.js, nothing at all, or a WebGL canvas, is entirely up to you.

> Bascik organizes your source. The browser runs your output. Any tool that works with HTML works with Bascik.

## The Core Principle

Every decision in Bascik follows three simple rules:

- **Be fast.** Build times are measured in milliseconds. In development, live reload updates your browser instantly. In production, zero runtime JavaScript is added, giving users maximum page load performance.
- **Be transparent.** There is no hidden runtime, no virtual DOM abstraction, and no framework black box. What you write in source is what ships in `dist/`: plain HTML, CSS, and JavaScript with deterministic, human-readable scoping prefixes.
- **Use what exists.** Use the standard HTML, CSS, and Javascript APIs. Do not invent a template language. Do not add a reactive data system. Do not require a runtime. Do not get between the developer and the browser.

Bascik exports configuration helpers (`defineConfig`) for your build, and nothing for your runtime code. Server scripts, stream scripts, and API routes receive standard web objects and import what they need from their own project or npm. If a task feels like it needs a Bascik helper, the answer is a five-line function in `src/lib/`, not a new export.

Bascik is a find-and-replace at build time. Custom component tags are resolved to their source HTML. CSS class names are scoped so they cannot collide. Script variables are isolated so they cannot leak. The output is a directory of vanilla HTML files that any server can host, any browser can render, and any tool can inspect without knowing Bascik exists.

> **Be fast. Be transparent.** Bascik organizes your source at build time and steps aside. The output is pure HTML, CSS, and JavaScript.

> **Next:** Read the [Getting Started guide](/getting-started) to install Bascik and write your first component in under five minutes. Or jump to [Scoping Compatibility](/compatibility) to see exactly what CSS and JavaScript patterns are supported.
