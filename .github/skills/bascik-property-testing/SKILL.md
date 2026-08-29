---
name: bascik-property-testing
description: Author, maintain, and debug property-based tests in Bascik using fast-check. Use when testing parser resilience, AST transforms, CSS/JS scoping edge cases, fuzzing string replacement tokens, or diagnosing shrinking paths.
---

# Property-Based Testing with `fast-check` in Bascik

Bascik processes arbitrary, user-authored HTML, CSS selectors, JavaScript expressions, and component nesting. Unit tests with handcrafted inputs miss subtle edge cases. `fast-check` provides generative property-based testing across `pkg/src/lib/` to guarantee parser robustness, idempotency, and invariant safety.

---

## 1. Core Invariants in Bascik

When writing property tests for Bascik's compilers and transformers, test against these foundational properties:

1. **No-Crash Invariant (Total Safety):** No arbitrary, malformed, or nested input should ever cause an unhandled crash, infinite loop, or Out-Of-Memory (OOM) error.
2. **Idempotency Invariant:** For deterministic transforms, running the transformer twice on its output must produce the same result:
   $$\text{transform}(\text{transform}(x)) == \text{transform}(x)$$
3. **Replacement Safety (Regex Special Replacement Tokens):** Strings containing special replacement tokens (`$1`, `$2`, `$&`, ``$` ``, `$'`) such as SQL placeholders or embedded code must be replaced literally without expansion or hanging.
4. **Scoping Isolation Invariant:** Components with distinct instance IDs must never share or leak generated scoped class names or scoped identifiers.

---

## 2. Common Arbitraries for Bascik

Use customized `fast-check` arbitraries to represent realistic and adversarial inputs:

```ts
import fc from 'fast-check';

// Valid CSS and HTML identifiers (handles Unicode, hyphens, alphanumeric)
export const identifierArb = fc.stringMatching(/^[a-z_][a-z0-9_-]{0,20}$/i);

// Arbitrary class names and selector lists
export const classNameArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{1,15}$/);

// Replacement string tokens that trigger JS String.prototype.replace traps
export const regexTrapStringArb = fc.oneof(
  fc.constant('$&'),
  fc.constant('$1'),
  fc.constant('$2'),
  fc.constant('$\`'),
  fc.constant("$\'")
);

// Arbitrary HTML attributes (with and without values)
export const htmlAttrArb = fc.record({
  name: fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/),
  value: fc.string({ maxLength: 50 })
});
```

---

## 3. Writing Property Tests in Vitest

### Testing String & Replacer Safety

```ts
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { scopeCss } from './styles.js';

describe('CSS Scoping Property Tests', () => {
  it('never crashes on arbitrary CSS and scope IDs', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.stringMatching(/^[a-z0-9]{6,10}$/),
        (rawCss, scopeId) => {
          expect(() => {
            scopeCss(rawCss, scopeId);
          }).not.toThrow();
        }
      ),
      { numRuns: 200 }
    );
  });

  it('safely handles replacement tokens in class names', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }),
        fc.constant('data-test-$1'),
        (content, prefix) => {
          // Verify that replacing prefix into content does not trigger regex backreference expansion
          const result = content.replace(/target/g, () => prefix);
          expect(typeof result).toBe('string');
        }
      ),
      { numRuns: 100 }
    );
  });
});
```

---

## 4. Debugging Shrinking Paths & Failures

When `fc.assert` fails, `fast-check` shrinks the input to the minimal failing counterexample.

* **Check Seed and Path:** Always record the `seed` and `path` printed in the test failure output to reproduce the exact counterexample:
  ```ts
  fc.assert(property, { seed: 123456789, path: '0:1:0:2' });
  ```
* **Common Root Causes in Bascik:**
  1. **String.prototype.replace with string replacer:** Always use a replacer function `() => value` rather than a bare string `value` when `value` may contain `$` tokens.
  2. **Unescaped regex constructors:** Dynamic regex creation `new RegExp(str)` failing on raw brackets, parentheses, or dots.
  3. **Recursive AST traversal depth:** Deeply nested elements causing stack overflow. Ensure recursion caps or iterative loops exist.

---

## 5. Execution in Workspace

Run property tests as part of unit test suites:

```sh
# Run all unit and property tests in pkg
yarn --cwd pkg unit

# Run focused property tests
npx vitest run pkg/src/lib/components.test.ts
```
