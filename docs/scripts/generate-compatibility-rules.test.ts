import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

describe('generate-compatibility-rules', () => {
  it('parses compatibility.md and generates compatibility rules JSON for the language server and the compiler', async () => {
    // Dynamically import the generator module so it executes its top-level script logic
    await import('./generate-compatibility-rules.js');

    // The VS Code extension has no copy: it runs the language server, which holds this one.
    const lspFile = path.resolve(import.meta.dirname, '../../lsp/src/compatibility-rules.json');
    const pkgFile = path.resolve(import.meta.dirname, '../../pkg/src/lib/compatibility-rules.json');
    const content = await fs.readFile(lspFile, 'utf8');
    expect(await fs.readFile(pkgFile, 'utf8')).toBe(content);
    const rules = JSON.parse(content);

    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.id).toBeTruthy();
      expect(['css', 'js']).toContain(rule.kind);
      expect(rule.pattern).toBeTruthy();
      expect(rule.message).toBeTruthy();
      expect(rule.suggestion).toBeTruthy();
      // Verify valid regex pattern
      expect(() => new RegExp(rule.pattern, rule.flags ?? '')).not.toThrow();
    }
  });
});
