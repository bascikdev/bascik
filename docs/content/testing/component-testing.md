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
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('alert-box component contract', () => {
  const filePath = join(process.cwd(), 'src/components/alert-box/alert-box.html');

  it('includes mandatory ARIA role and slot placeholders', async () => {
    const html = await readFile(filePath, 'utf8');

    // Verify accessibility attributes
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');

    // Verify named slot placement
    expect(html).toContain('data-bascik-slot="title"');

    // Verify pure CSS state control (no runtime script tag)
    const clientScriptRegex = /<script(?![^>]*data-bascik-build)[^>]*>[\s\S]*?<\/script>/gi;
    expect(clientScriptRegex.test(html)).toBe(false);
  });
});
```

## Testing Compiled Build Output (`dist/`)

Testing compiled pages in `dist/` validates that Bascik expanded custom tags, filled slots, substituted props, and cleaned internal markers during compilation.

### Example: Validating Production Output

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Compiled production build output', () => {
  const indexPath = join(process.cwd(), 'dist/index.html');

  it('expands custom tags and resolves props without leftover markers', async () => {
    const html = await readFile(indexPath, 'utf8');

    // Verify component tags expanded
    expect(html).not.toContain('<alert-box');
    expect(html).not.toContain('<user-badge');

    // Verify prop placeholders were replaced
    expect(html).not.toContain('data-bascik-prop-');

    // Verify slot attributes were removed from final markup
    expect(html).not.toContain('data-bascik-slot');

    // Verify slotted text content exists in the page
    expect(html).toContain('System Update Completed');
  });
});
```

## Testing Slot Fallback Defaults and Prop Substitutions

When authoring components with optional slots or fallback content, verify both the default state and the customized state:

```ts
// src/components/modal/modal.test.ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('Modal component fallback contract', () => {
  it('contains default fallback markup for optional action slot', async () => {
    const html = await readFile(join(process.cwd(), 'src/components/modal/modal.html'), 'utf8');

    // Verify default fallback button exists inside the slot tag
    expect(html).toMatch(/<div[^>]*data-bascik-slot="actions"[^>]*>[\s\S]*?<button[^>]*>Close<\/button>/);
  });
});
```

## Validating HTML Spec Compliance with parse5

Bascik is a build tool, not a browser. Browsers silently recover from malformed HTML. Bascik's job is to deliver output that is correct by construction — so holding your dist to the full WHATWG HTML5 spec is the right bar.

[parse5](https://parse5.js.org/) is the reference WHATWG-spec HTML5 parser used by jsdom and Playwright. Install it as a dev dependency and use its `onParseError` callback to fail your test on any spec violation:

```sh
npm install --save-dev parse5
```

```ts
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type ParserError } from 'parse5';

const DIST_DIR = path.resolve(process.cwd(), 'dist');

async function walk(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, ext)));
    else if (entry.isFile() && entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

describe('dist HTML — WHATWG spec compliance', () => {
  it('every page is free of parse errors', async () => {
    const files = await walk(DIST_DIR, '.html');
    const failures: string[] = [];

    for (const file of files) {
      const html = await readFile(file, 'utf-8');
      const errors: ParserError[] = [];
      parse(html, {
        sourceCodeLocationInfo: true,
        onParseError: (err) => errors.push(err),
      });
      for (const err of errors) {
        const lines = html.split('\n');
        const srcLine = (err.startLine ?? 0) > 0
          ? lines[(err.startLine ?? 1) - 1].slice(0, 120)
          : '';
        failures.push(
          `${path.relative(DIST_DIR, file)}:${err.startLine}:${err.startCol}  [${err.code}]` +
          (srcLine ? `\n  ${srcLine}` : ''),
        );
      }
    }

    expect(failures, failures.join('\n\n')).toHaveLength(0);
  });
});
```

The `onParseError` callback receives a `ParserError` with a `code` field — a WHATWG error code string like `eof-in-element-that-can-contain-only-text` or `unexpected-null-character` — plus `startLine` and `startCol` for actionable failure messages. `sourceCodeLocationInfo: true` is what unlocks line/column reporting.

This single test catches an entire class of compiler pipeline bugs — corrupted script bodies, mismatched tags, raw control characters from unreplaced internal tokens — that regex-based output checks miss entirely.

## What to Test vs What to Avoid

- **Test Compiled Outputs**: Assert that components resolve completely and render valid HTML without leftover compiler attributes.
- **Test Accessibility Contracts**: Assert that interactive controls have explicit `type="button"`, `aria-expanded`, or `aria-label` attributes.
- **Validate Spec Compliance**: Use parse5 to parse every `dist/` HTML file with `onParseError` and fail on any WHATWG parse error. This catches structural corruption that string assertions cannot.
- **Avoid Trivial Regex Assertions**: Avoid reading raw `.html` files simply to verify static text like `class="card"`. Test functional compiler output or accessibility rules instead.
