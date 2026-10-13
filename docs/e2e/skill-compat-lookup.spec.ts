// Runs the bascik-compatibility lookup script against the built docs site, so a change to the compatibility page's
// markup that the script can no longer read fails here instead of in an assistant's session.
import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lookup = join(fileURLToPath(new URL('../../skills', import.meta.url)), 'bascik-compatibility/scripts/lookup.mjs');

function run(baseURL: string, args: string[]) {
  const result = spawnSync(process.execPath, [lookup, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BASCIK_DOCS_URL: baseURL },
    timeout: 30_000,
  });
  return { ...result, combined: `${result.stdout}\n${result.stderr}` };
}

test('lookup.mjs reads every table section of the live compatibility page', async ({ baseURL }) => {
  const listed = run(baseURL!, ['--list', '--json']);
  expect(listed.status, listed.combined).toBe(0);
  const sections = JSON.parse(listed.stdout) as Array<{ section: string; count: number }>;
  const names = sections.map((s) => s.section);
  for (const expected of ['ID References', 'Server & API Features', 'CSS Scoping > Selectors', 'JavaScript Scoping > DOM Selector Rewriting']) {
    expect(names).toContain(expected);
  }
  expect(sections.reduce((sum, s) => sum + s.count, 0)).toBeGreaterThan(100);
});

test('lookup.mjs reports the status the page shows for known patterns', async ({ baseURL }) => {
  const statusOf = (query: string, column: string, value: string) => {
    const found = run(baseURL!, [query, '--json', '--limit', '50']);
    expect(found.status, found.combined).toBe(0);
    const rows = JSON.parse(found.stdout).rows as Array<{ status: string; cells: Record<string, string> }>;
    return rows.find((row) => row.cells[column] === value)?.status;
  };
  expect(statusOf('container', 'Pattern', '@container')).toBe('✓');
  expect(statusOf(':is element', 'Pattern', ':is() / :where() / :has() with element names')).toBe('✕');
  expect(statusOf('setProperty', 'Method', 'element.style.setProperty for CSS vars')).toBe('✕');
  expect(statusOf('attribute selector', 'Pattern', 'Attribute selector')).toBe('△');

  const missing = run(baseURL!, ['zzz-no-such-pattern']);
  expect(missing.status).toBe(1);
  expect(missing.stdout).toContain('No compatibility rows match');
});
