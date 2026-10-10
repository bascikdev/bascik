# Minification

Bascik features zero-dependency minifiers for HTML, CSS, and JavaScript, deterministic identifier hashing for scoped selectors, and custom minifier extensibility.

## Overview

Minification reduces payload sizes without introducing heavy external bundlers or AST parsers. Bascik includes three specialized minification passes:

- **`html-minifier.ts`**: Strips comments, consolidates eligible scripts, and collapses whitespace, deciding from a spec-following scan of the document (`html-scanner.ts`) what each part of the markup is.
- **`css-minifier.ts`**: Removes comments and structural whitespace while shielding string literals and `url()` definitions.
- **`js-minifier.ts`**: Strips comments and unnecessary spaces while preserving string literals, template literals, and regex literals verbatim.
- **Identifier Hashing (`names.ts`)**: Hashes scoped class names and element IDs using SHA-256 and Base62 encoding when `minify.identifiers: true` is configured.
- **BYO Minifier**: Supports custom third-party minifier integrations (`esbuild`, `SWC`, `PostCSS`, `Lightning CSS`) configured in `bascik.config.ts`.

## Zero-AST Lexical Context Preservation

Traditional build tools rely on heavy Abstract Syntax Tree (AST) parsers to minify code safely. Bascik achieves equivalent safety and higher throughput using zero-dependency lexical context preservation:

1. **HTML Tokenizer Scan:** `html-scanner.ts` walks the document once, following the WHATWG HTML tokenizer states, and splits it into text, tags, raw text bodies, and other markup. Comment-like text inside a `<script>` or `<style>`, a quoted `>` in an attribute value, and malformed markup such as `<scr<script>` are all read the way a browser reads them, so they are never mistaken for document structure.
2. **CSS String and Resource Shielding:** Quoted string literals and `url(...)` declarations in CSS can contain colons, semicolons, or multiple spaces (such as data URIs or content strings). `shieldCssStrings` extracts these values into temporary tokens before structural whitespace stripping, restoring them unchanged afterward.
3. **JS Lexical Context and Regex Disambiguation:** JavaScript code is segmented into literal regions (quoted strings, template literals, regexes) and minifiable code regions. To disambiguate the forward slash `/` character (which can represent either a division operator or a regex literal), `js-minifier.ts` tracks preceding keyword context (such as `return`, `case`, `typeof`, `yield`, `await`). Forward slashes following expression keywords are preserved as regex literals.

## HTML Minification (`html-minifier.ts`)

`minifyHtml` makes two linear passes, each driven by the scanner:

1. Scan the document, remove its comments, and take out the client scripts selected for consolidation.
2. Scan the result and collapse whitespace token by token, then place the consolidated scripts.

The goal is that the minified page parses to the same document, with the same scripts able to run. The test suite checks this against `parse5`, a spec-compliant HTML parser, on random malformed markup.

### Key HTML Minification Behaviors

1. **Comment Stripping**: Every HTML comment the browser would parse is removed, including ones ending in `--!>`, except inside `<pre>` and `<listing>`, whose content stays verbatim. Comment-like text inside raw text and RCDATA elements (`<script>`, `<style>`, `<textarea>`, `<title>`, `<noscript>`) is not a comment and is left in place, so CSS CDO/CDC tokens (`<!--` and `-->`) inside a `<style>` element survive. Removing markup never joins the text around it into new markup: where it could (`<` then `<!-- c -->script>`, or `&am<!-- -->p;`), an empty `<!---->` takes its place.
2. **Verbatim Content**: `<pre>` and `<listing>` content, raw text and RCDATA bodies (`<script>`, `<style>`, `<textarea>`, `<xmp>`, `<noscript>`, `<iframe>`), SVG and MathML `<script>` and `<style>`, attribute values, DOCTYPEs, and CDATA sections are never changed. Whitespace between a tag's attributes collapses, since it never renders. `<title>` text collapses, because `document.title` collapses it anyway.
3. **Whitespace Collapsing**: In other text, every line break and every run of spaces, tabs, and line breaks becomes one space. Only that whitespace is touched: U+00A0 (`&nbsp;` written as a character), other Unicode spaces, and form feeds are content and stay. Whitespace-only text between two tags is removed, or kept as one space when both are inline elements (`INLINE_TAGS`: `a`, `span`, `b`, `strong`, `code`, `textarea`, ...). While a formatting element such as `<a>` or `<b>` may be open, it is kept as one space instead, because whitespace makes the parser re-create a misnested formatting element.
4. **Script Consolidation**: Eligible classic and module client scripts are moved to the end of the document, in their original order. Build, routes, server, and data scripts stay in place, as do scripts in `<template>`, `<pre>`, SVG, or MathML. A script that must run in place (an import map, or one of those) keeps every earlier script before it. When the document ends inside markup where an appended script would not run, such as an unclosed tag, comment, `<template>`, or `<textarea>`, the scripts go just before it.

### Known HTML Limits

- **CSS-dependent whitespace**: The minifier does not read your CSS. An element other than `<pre>` or `<listing>` styled `white-space: pre`, `pre-wrap`, `pre-line`, or `break-spaces` loses its extra spaces and line breaks, and an element made inline with CSS can lose the space next to it. Use `<pre>` for preformatted text, or set `minify.html: false`.
- **Malformed markup the scan cannot follow**: In a few rare constructs, such as raw text or SVG elements inside `<select>`, `<frameset>`, CDATA inside SVG `<title>`, or SVG and MathML end tags that close elements outside them, the scan stops and the rest of the document is left as written. Inside `<pre>` after a `<table>` or `<select>`, it keeps treating the content as preformatted until the next `<template>` boundary, which only keeps more whitespace.

JavaScript minification applies to scripts with no `type` and to `text/javascript`, `module`, `application/javascript`, `text/ecmascript`, and `application/ecmascript`. External `src` scripts and non-JavaScript data scripts are not minified.

## CSS Minification (`css-minifier.ts`)

`minifyCss` reduces stylesheet sizes by stripping comments and collapsing whitespace around CSS syntax delimiters (`{`, `}`, `:`, `;`, `,`).

```ts
export const minifyCss = (css: string): string => {
  const { css: shielded, restore } = shieldCssStrings(removeCommentsFromCss(css));
  const minified = shielded
    .replace(/\n/g, " ")
    .replace(/\s\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .trim();
  return restore(minified);
};
```

### String and URL Shielding (`shieldCssStrings`)

CSS property values can contain strings, data URIs, or custom properties containing colons, semicolons, or multiple spaces:

```css
.badge::after {
  content: "Status: Active; Version 1.0";
}
.hero {
  background-image: url("data:image/svg+xml;charset=utf-8,...");
}
```

`shieldCssStrings` extracts quoted string literals and `url(...)` declarations before minification runs, replacing them with temporary tokens. After structural whitespace is stripped, `restore()` re-injects the original string content unchanged.

## JavaScript Minification (`js-minifier.ts`)

`minifyJs` performs single-pass lexical scanning to strip comments and collapse whitespace in client-side scripts.

### Lexical Segmenting

JavaScript source code is divided into literal segments (which must be preserved verbatim) and minifiable code segments:

```ts
type Segment = { literal: boolean; text: string };
```

Quoted strings (`"..."`, `'...'`), template literals (`` `...` ``), and regex literals (`/.../`) are placed in literal segments.

### Regex Disambiguation

A forward slash `/` can denote either a division operator or the start of a regular expression literal. To disambiguate, `js-minifier.ts` tracks preceding keyword context:

```ts
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "yield",
  "await",
  "delete",
  "typeof",
  "void",
  "default",
  "in",
  "of",
  "instanceof",
  "new",
  "do",
]);
```

When `/` follows an operator or expression keyword, it is parsed as a regular expression literal and preserved intact.

## Identifier Hashing (`names.ts`)

When production identifier minification is enabled (`minify.identifiers: true`), Bascik replaces long scoped class names and element IDs with compressed alphanumeric hashes.

### Base62 Hash Encoding

`names.ts` computes SHA-256 digests of scoped attribute names and encodes the first 64 bits into a Base62 string:

```ts
const BASE62_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const toBase62 = (num: bigint, length = 11): string => {
  if (num === 0n) return "0".repeat(length);
  let str = "";
  let current = num;
  while (current > 0n) {
    const remainder = Number(current % 62n);
    str = BASE62_ALPHABET[remainder] + str;
    current = current / 62n;
  }
  return str.padStart(length, "0");
};

export const getAttributeNameHash = (attributeName: string): string => {
  const digest = createHash("sha256").update(attributeName).digest();
  const num = typeof digest === "string" ? Buffer.from(digest).readBigUInt64BE(0) : digest.readBigUInt64BE(0);
  return `b${toBase62(num, 11)}`;
};
```

The output is prefixed with a `b` character to ensure class and ID names always begin with a valid CSS letter identifier rather than a digit (for example, `b2Y4G9eD1K8b`).

### `O(1)` Hash Memoization (`hashCache`)

To eliminate redundant crypto and string allocations during builds, `getAttributeNameHash` caches computed Base62 hashes in an in-memory `Map<string, string>` (`hashCache`). Subsequent encounters of identical attribute names across pages or components return the cached hash instantly with 0 SHA-256 digests, BigInt conversions, or string creation overhead.

## Bring Your Own Minifier (BYO Minifier)

For projects with specialized optimization needs, Bascik allows overriding the default minifiers in `bascik.config.ts`. Custom minifiers can be synchronous or asynchronous.

### Integration Examples

#### JavaScript with esbuild

```ts
import { transform } from 'esbuild';

export default {
  minify: {
    js: async (code: string) => {
      const result = await transform(code, { loader: 'js', minify: true });
      return result.code.trim();
    },
  },
};
```

#### CSS with Lightning CSS or PostCSS

```ts
import postcss from 'postcss';
import autoprefixer from 'autoprefixer';

export default {
  minify: {
    css: async (code: string) => {
      const result = await postcss([autoprefixer]).process(code, { from: undefined });
      return result.css;
    },
  },
};
```

When custom minifier functions are provided, Bascik routes compiled assets through the custom handlers during the final build phase.
