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

## What to Test vs What to Avoid

- **Test Compiled Outputs**: Assert that components resolve completely and render valid HTML without leftover compiler attributes.
- **Test Accessibility Contracts**: Assert that interactive controls have explicit `type="button"`, `aria-expanded`, or `aria-label` attributes.
- **Avoid Trivial Regex Assertions**: Avoid reading raw `.html` files simply to verify static text like `class="card"`. Test functional compiler output or accessibility rules instead.
