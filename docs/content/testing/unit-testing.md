# Unit Testing

Unit testing in Bascik focuses on verifying pure functions, utility modules, data transformers, and business logic in isolation. Because Node 24 and Node 22.18+ natively execute TypeScript files by erasing type annotations, Vitest executes unit tests directly against `.ts` files with zero build delay.

## Setting Up Vitest

If your project was scaffolded with `create-bascik`, Vitest is pre-configured. To set up Vitest manually in an existing project, install the dependencies:

```sh
npm install -D vitest @vitest/coverage-v8
```

Create a `vite.config.js` file in your project root:

```js
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
```

Add test commands to your `package.json`:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "test:coverage": "vitest run --coverage"
}
```

## Writing High-Value Unit Tests

Focus unit tests on core business logic, algorithm correctness, and edge-case handling rather than trivial property checks.

### Example: Testing Pure Calculation Functions

```ts
// src/utils/formatters.ts
export function formatCurrency(cents: number, currency = 'USD'): string {
  if (isNaN(cents) || cents < 0) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(cents / 100);
}
```

```ts
// src/utils/formatters.test.ts
import { describe, it, expect } from 'vitest';
import { formatCurrency } from './formatters.ts';

describe('formatCurrency', () => {
  it('formats positive cent values correctly', () => {
    expect(formatCurrency(1999)).toBe('$19.99');
    expect(formatCurrency(500)).toBe('$5.00');
  });

  it('handles zero and invalid inputs gracefully', () => {
    expect(formatCurrency(0)).toBe('$0.00');
    expect(formatCurrency(-500)).toBe('$0.00');
    expect(formatCurrency(NaN)).toBe('$0.00');
  });
});
```

## V8 Code Coverage Reports

Running `npm run test:coverage` generates comprehensive code coverage metrics powered by `@vitest/coverage-v8`:

- **Terminal Summary**: Displays statement, branch, function, and line coverage percentages directly in stdout.
- **Interactive HTML Report**: Generated in `coverage/index.html` for line-by-line inspection of untested paths in any browser.
- **CI Artifacts**: Saved in `coverage/coverage-final.json` for integration into automated CI/CD pipelines.

> **Tip:** Add `coverage/` to your `.gitignore` file to prevent committing generated coverage artifacts to version control.
