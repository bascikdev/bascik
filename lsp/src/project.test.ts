import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveComponentRoots } from './project.js';

describe('resolveComponentRoots', () => {
  const workRoot = path.resolve('/work').replace(/\\/g, '/');

  it('resolves roots against the workspace with forward slashes and no trailing slash', () => {
    expect(resolveComponentRoots('/work', ['src/components/', 'shared'])).toEqual([
      `${workRoot}/src/components`,
      `${workRoot}/shared`,
    ]);
  });

  it('runs in linear time on a long slash run that does not end the root', () => {
    // Backslashes survive POSIX `path.resolve` and become a slash run; the old
    // `/\/+$/` trim was quadratic on it.
    const root = `a${'\\'.repeat(50_000)}b`;
    const start = performance.now();
    const [resolved] = resolveComponentRoots('/work', [root]);
    expect(performance.now() - start).toBeLessThan(250);
    expect(resolved).toMatch(new RegExp(`^${workRoot}/a/+b$`));
  });
});
