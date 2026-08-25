# Minification

Bascik features zero-dependency minifiers for HTML, CSS, and JavaScript, deterministic identifier hashing for scoped selectors, and custom minifier extensibility.

## Overview

Minification reduces payload sizes without introducing heavy external bundlers or AST parsers. Bascik includes three specialized minification passes:

- **`html-minifier.ts`**: Strips comments, consolidates script blocks, and collapses whitespace while protecting `<pre>` and `<textarea>` content.
- **`css-minifier.ts`**: Removes comments and structural whitespace while shielding string literals and `url()` definitions.
- **`js-minifier.ts`**: Strips comments and unnecessary spaces while preserving string literals, template literals, and regex literals verbatim.
- **Identifier Hashing (`names.ts`)**: Hashes scoped class names and element IDs using SHA-256 and Base62 encoding when `minify.identifiers: true` is configured.
- **BYO Minifier**: Supports custom third-party minifier integrations (`esbuild`, `SWC`, `PostCSS`, `Lightning CSS`) configured in `bascik.config.ts`.

## Zero-AST Lexical Context Preservation

Traditional build tools rely on heavy Abstract Syntax Tree (AST) parsers to minify code safely. Bascik achieves equivalent safety and higher throughput using zero-dependency lexical context preservation:

1. **HTML Null-Byte Token Shielding:** Whitespace-sensitive elements (`<pre>` and `<textarea>`) are extracted and replaced with null-byte placeholders (`\x00P0\x00`) before whitespace collapsing runs. This prevents code blocks and formatted text from losing indentation or newlines.
2. **CSS String and Resource Shielding:** Quoted string literals and `url(...)` declarations in CSS can contain colons, semicolons, or multiple spaces (such as data URIs or content strings). `shieldCssStrings` extracts these values into temporary tokens before structural whitespace stripping, restoring them unchanged afterward.
3. **JS Lexical Context and Regex Disambiguation:** JavaScript code is segmented into literal regions (quoted strings, template literals, regexes) and minifiable code regions. To disambiguate the forward slash `/` character (which can represent either a division operator or a regex literal), `js-minifier.ts` tracks preceding keyword context (such as `return`, `case`, `typeof`, `yield`, `await`). Forward slashes following expression keywords are preserved as regex literals.

## HTML Minification (`html-minifier.ts`)

`minifyHtml` optimizes HTML documents through structural transformations and whitespace rules:

```ts
export const minifyHtml = (htmlString: string): string => {
  let html = htmlString.replace(/<!--[\s\S]*?-->/g, "");
  const scriptTags = extractScriptTags(html);
  if (scriptTags) {
    const pattern = new RegExp(`<script[^>]*>([\\s\\S]*?)<\\/script>`, "gi");
    html = html.replace(pattern, "").trim();
  }

  const preserved: string[] = [];
  html = html.replace(
    /<(pre|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      preserved.push(match);
      return `\x00P${preserved.length - 1}\x00`;
    },
  );

  html = html.replace(/\n/g, " ").replace(/\s\s+/g, " ");
  // Whitespace collapsing between tags...
  // Restores preserved <pre> / <textarea> blocks
  // Appends consolidated script tags to document end
  return html;
};
```

### Key HTML Minification Behaviors

1. **Comment Stripping**: All HTML comments (`<!-- ... -->`) are removed.
2. **Whitespace-Sensitive Shielding**: The contents of `<pre>` and `<textarea>` elements are stored in a temporary array and replaced with null-byte placeholders (`\x00P0\x00`). This ensures code blocks and formatted text preserve indentation and newlines.
3. **Smart Inline Tag Spacing & $O(1)$ Tag-Boundary Scanning**: Whitespace between block-level tags (`</div> <div>`) is collapsed completely (`"></div><div>"`). For inline tags (`a`, `span`, `b`, `strong`, `code`), a single space is preserved between adjacent elements (`"> <"`). Tag boundary matching uses $O(1)$ backwards scanning (`lastIndexOf('<', offset)`) and bounded slices rather than full-string `slice(0, offset)` allocations, avoiding $O(N^2)$ memory churn and V8 garbage collection overhead on large HTML pages.
4. **Script Consolidation**: Inline `<script>` tags are extracted and re-appended at the end of the document, reducing head blocking and improving HTML parsing performance.

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

### $O(1)$ Hash Memoization (`hashCache`)

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
