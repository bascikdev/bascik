# Component Testing

Component testing in Bascik validates `.html` component templates before compilation and verifies compiled HTML output in `dist/` after building.

## Component Template Contract Testing

Test component `.html` files before transpilation to verify structural requirements, accessibility attributes, and script discipline.

### Co-Located Component Files

Keep component contract tests right next to the component HTML file:

```text
src/components/alert-box/
  alert-box.html        ← component template and styles
  alert-box.test.ts      ← Vitest contract test
```

### Example: Verifying Accessibility and Script Contracts

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("alert-box component contract", () => {
  const filePath = join(
    process.cwd(),
    "src/components/alert-box/alert-box.html",
  );

  it("includes mandatory ARIA role and slot placeholders", async () => {
    const html = await readFile(filePath, "utf8");

    // Verify accessibility attributes
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');

    // Verify named slot placement
    expect(html).toContain('data-bascik-slot="title"');

    // Verify pure CSS state control (no runtime script tag)
    const clientScriptRegex =
      /<script(?![^>]*data-bascik-build)[^>]*>[\s\S]*?<\/script>/gi;
    expect(clientScriptRegex.test(html)).toBe(false);
  });
});
```

## Testing Compiled Build Output (`dist/`)

Testing compiled pages in `dist/` validates that Bascik expanded custom tags, filled slots, substituted props, and cleaned internal markers during compilation.

### Example: Validating Production Output

```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("Compiled production build output", () => {
  const indexPath = join(process.cwd(), "dist/index.html");

  it("expands custom tags and resolves props without leftover markers", async () => {
    const html = await readFile(indexPath, "utf8");

    // Verify component tags expanded
    expect(html).not.toContain("<alert-box");
    expect(html).not.toContain("<user-badge");

    // Verify prop placeholders were replaced
    expect(html).not.toContain("data-bascik-prop-");

    // Verify slot attributes were removed from final markup
    expect(html).not.toContain("data-bascik-slot");

    // Verify slotted text content exists in the page
    expect(html).toContain("System Update Completed");
  });
});
```

## Optional CSS Diagnostics on Compiled HTML

Spot suspicious markup visually while reviewing a built page, without adding a testing dependency. For example, outline a figure containing more than one direct caption:

```css
figure:has(> figcaption ~ figcaption) {
  outline: 3px dashed crimson;
  --error-figure-duplicate-caption: "Keep only one direct figcaption.";
}
```

This development-only technique is inspired by Heydon Pickering's [Testing HTML With Modern CSS](https://heydonworks.com/article/testing-html-with-modern-css/). These are small, project-specific review aids, not a replacement for HTML validation, accessibility audits, or browser tests.

### Try It Without Shipping It

1. Build with `bascik --build`, then serve `dist/` locally with `bascik --server` and open the route to review.
2. In DevTools, add the CSS as a temporary, **unlayered global stylesheet**, for example by editing a temporary `style` element in the document head. Do not save it to source files through DevTools workspaces or overrides.
3. Inspect an outlined element. In the Styles panel, filter for `--error-` to read each diagnostic. Give every check a different custom property name so several messages can coexist.
4. Fix confirmed issues in the source component or page, rebuild, and check again. Remove the temporary sheet when finished; never include it in a deployment.

Use outlines because they do not consume layout space. Keep messages in custom properties rather than `::before` or `::after` content, which can move or obscure the very layout being tested. Custom properties inherit: a message listed as inherited in DevTools belongs to an ancestor, not necessarily the selected element.

> **Bascik scoping.** Run these selectors globally against compiled HTML, never in a component's inline or companion stylesheet. Bascik rewrites component selectors, and element names inside `:is()` and `:has()` are not converted like standalone element selectors. A diagnostic must examine the actual composed DOM across component boundaries, not scoped source names. See [Compatibility](/compatibility#css-scoping).

### Add Checks for Your Markup Contracts

Only add a missing-caption check if your project requires every figure to have a visible caption. A figure without a caption is not automatically invalid HTML:

```css
figure:not(:has(> figcaption)) {
  outline: 3px dashed darkorange;
  --error-figure-missing-caption: "Review whether this figure needs a visible caption.";
}
```

For native labels, look for neither an explicit association nor a wrapped labelable element:

```css
label:not([for]):not(
    :has(
      button,
      input:not([type="hidden" i]),
      meter,
      output,
      progress,
      select,
      textarea
    )
  ) {
  outline: 3px dashed crimson;
  --error-label-unassociated: "Review this label: no for attribute or native labelable descendant.";
}
```

This is a heuristic, not a complete association check. A `for` attribute can point to a missing, duplicated, or non-labelable ID; its presence proves nothing about its target. Form-associated custom elements can also be labelable and are not covered by this selector. Use browser tests such as `getByLabel()` and inspect the accessibility tree to verify the intended control and accessible name.

Treat other tempting checks with the same care: `alt=""` can correctly mark a decorative image, and an anchor without `href` can be an intentional placeholder. CSS cannot judge text alternative quality, resolve arbitrary ID references, or prove accessibility. Browser DOM repair can also hide malformed source markup from selectors, so keep the [HTML parsing checks](#validating-html-spec-compliance-with-parse5).

### Account for the Cascade

A last-declared `tests` layer is not a universal override. **Normal unlayered author styles outrank every normal layered author style**, regardless of layer order or selector specificity. A final tests layer wins over the site's normal rules only when those rules are in earlier layers.

Prefer the temporary unlayered DevTools sheet. Within the same origin and importance, inline styles or more specific rules can still hide an outline; inspect the matched rules and isolate the conflicting declaration during review instead of adding pervasive `!important`. Diagnostic messages may remain inspectable even when an outline loses the cascade.

Keep relational checks anchored to the element being reviewed, such as `figure` or `label`, rather than searching from `body:has(...)`. Use a current browser with `:has()` support for this optional workflow; an unsupported selector or a page with no outlines is not a passing test result.

## Testing Slot Fallback Defaults and Prop Substitutions

When authoring components with optional slots or fallback content, verify both the default state and the customized state:

```ts
// src/components/modal/modal.test.ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("Modal component fallback contract", () => {
  it("contains default fallback markup for optional action slot", async () => {
    const html = await readFile(
      join(process.cwd(), "src/components/modal/modal.html"),
      "utf8",
    );

    // Verify default fallback button exists inside the slot tag
    expect(html).toMatch(
      /<div[^>]*data-bascik-slot="actions"[^>]*>[\s\S]*?<button[^>]*>Close<\/button>/,
    );
  });
});
```

## Validating HTML Spec Compliance with parse5

Bascik is a build tool, not a browser. Browsers silently recover from malformed HTML. Bascik's job is to deliver output that is correct by construction, so holding your dist to the full WHATWG HTML5 spec is the right bar.

[parse5](https://parse5.js.org/) is the reference WHATWG-spec HTML5 parser used by jsdom and Playwright. Install it as a dev dependency and use its `onParseError` callback to fail your test on any spec violation:

```sh
npm install --save-dev parse5
```

```ts
import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse, type ParserError } from "parse5";

const DIST_DIR = path.resolve(process.cwd(), "dist");

async function walk(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, ext)));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

describe("dist HTML: WHATWG spec compliance", () => {
  it("every page is free of parse errors", async () => {
    const files = await walk(DIST_DIR, ".html");
    const failures: string[] = [];

    for (const file of files) {
      const html = await readFile(file, "utf-8");
      const errors: ParserError[] = [];
      parse(html, {
        sourceCodeLocationInfo: true,
        onParseError: (err) => errors.push(err),
      });
      for (const err of errors) {
        const lines = html.split("\n");
        const srcLine =
          (err.startLine ?? 0) > 0
            ? lines[(err.startLine ?? 1) - 1].slice(0, 120)
            : "";
        failures.push(
          `${path.relative(DIST_DIR, file)}:${err.startLine}:${err.startCol}  [${err.code}]` +
            (srcLine ? `\n  ${srcLine}` : ""),
        );
      }
    }

    expect(failures, failures.join("\n\n")).toHaveLength(0);
  });
});
```

The `onParseError` callback receives a `ParserError` with a `code` field (a WHATWG error code string like `eof-in-element-that-can-contain-only-text` or `unexpected-null-character`) plus `startLine` and `startCol` for actionable failure messages. `sourceCodeLocationInfo: true` is what unlocks line/column reporting.

This single test catches an entire class of compiler pipeline bugs, such as corrupted script bodies, mismatched tags, and raw control characters from unreplaced internal tokens, that regex-based output checks miss entirely.

## What to Test vs What to Avoid

- **Test Compiled Outputs**: Assert that components resolve completely and render valid HTML without leftover compiler attributes.
- **Test Accessibility Contracts**: Assert that interactive controls have explicit `type="button"`, `aria-expanded`, or `aria-label` attributes.
- **Validate Spec Compliance**: Use parse5 to parse every `dist/` HTML file with `onParseError` and fail on any WHATWG parse error. This catches structural corruption that string assertions cannot.
- **Avoid Trivial Regex Assertions**: Avoid reading raw `.html` files simply to verify static text like `class="card"`. Test functional compiler output or accessibility rules instead.

## Next Steps

Use [E2E Testing](/testing/e2e-testing) for browser assertions and [Linting](/testing/linting#check-the-built-site) for optional standards and accessibility checks on the built site.
