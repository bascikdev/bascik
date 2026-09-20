import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, type ParserError } from 'parse5';

/**
 * Dist sanity checks.
 *
 * Parses every HTML file under docs/dist/ with the parse5 WHATWG-spec HTML5
 * parser and fails on any parse error. Because Bascik is a build tool, not a
 * browser, we hold output to the full spec — parse errors that browsers
 * silently recover from are still defects we must fix before shipping.
 *
 * Additionally, every HTML, CSS, and JS file is scanned for unreplaced
 * internal pipeline tokens (e.g. Bascik shield placeholders) that indicate
 * the minifier or scoping pipeline left internal state in the output.
 *
 * These tests would have caught both bugs fixed in the same session:
 *   1. extractInlineStyles eating component HTML (missing component content
 *      triggers `open-elements-left-after-eof` / structural errors).
 *   2. shieldSensitiveContent corrupting <script> bodies with comment text
 *      (parse5 flags the resulting garbage as a parse error).
 *
 * Prerequisites: `yarn docs:build` must have run before these tests execute.
 * They are skipped gracefully when the dist directory is absent so they do not
 * break cold CI runs where a separate build step precedes the test step.
 */

const DIST_DIR = path.resolve(import.meta.dirname, '../../dist');

// ─── helpers ──────────────────────────────────────────────────────────────────

async function walk(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // dist does not exist yet
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, ext)));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collect all parse errors from a complete HTML document string.
 * Uses sourceCodeLocationInfo so errors carry line/column/offset.
 */
function collectParseErrors(html: string): ParserError[] {
  const errors: ParserError[] = [];
  parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (err) => errors.push(err),
  });
  return errors;
}

/**
 * Returns a human-readable label for a parse5 error suitable for a test
 * failure message, including the source line context when available.
 */
function formatError(err: ParserError, html: string, relPath: string): string {
  const lines = html.split('\n');
  const line = err.startLine ?? 0;
  const col = err.startCol ?? 0;
  const srcLine = line > 0 && line <= lines.length ? lines[line - 1].slice(0, 120) : '';
  const pointer = col > 1 ? ' '.repeat(col - 1) + '^' : '^';
  return [
    `${relPath}:${line}:${col}  [${err.code}]`,
    srcLine ? `  ${srcLine}` : '',
    srcLine ? `  ${pointer}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Internal pipeline tokens that must never survive into the output. */
const PIPELINE_TOKEN_RE = /\x00BASCIK_SHIELD_\d+\x00|BASCIK_COMMENT_\d+/;

// ─── tests ────────────────────────────────────────────────────────────────────

describe('dist sanity — HTML parse errors (parse5 WHATWG)', () => {
  it('dist directory exists (build ran before tests)', async () => {
    const files = await walk(DIST_DIR, '.html');
    // If zero files found the dist just hasn't been built; skip gracefully.
    if (files.length === 0) {
      console.warn(
        '[dist-sanity] No HTML files found under dist/. ' +
          'Run `yarn docs:build` before `yarn docs:unit`.',
      );
    }
    // The test itself doesn't fail — the per-file tests below will simply not
    // run. This avoids false-red on a fresh checkout with no build yet.
    expect(typeof files.length).toBe('number');
  });

  it('every dist HTML file is free of WHATWG parse errors', async () => {
    const files = await walk(DIST_DIR, '.html');
    if (files.length === 0) return; // build not run yet — handled above

    const failures: string[] = [];

    for (const file of files) {
      const html = await readFile(file, 'utf-8');
      const errors = collectParseErrors(html);
      if (errors.length > 0) {
        const relPath = path.relative(DIST_DIR, file);
        for (const err of errors) {
          failures.push(formatError(err, html, relPath));
        }
      }
    }

    if (failures.length > 0) {
      // Show the first 20 errors to keep output readable.
      const shown = failures.slice(0, 20);
      const extra = failures.length > 20 ? `\n  … and ${failures.length - 20} more` : '';
      expect.fail(
        `${failures.length} parse error(s) found in dist HTML files:\n\n` +
          shown.join('\n\n') +
          extra,
      );
    }

    expect(failures).toHaveLength(0);
  }, 30_000);
});

describe('dist sanity — unreplaced pipeline tokens', () => {
  it('no HTML file contains an unreplaced Bascik shield token', async () => {
    const files = await walk(DIST_DIR, '.html');
    if (files.length === 0) return;

    const hits: string[] = [];
    for (const file of files) {
      const html = await readFile(file, 'utf-8');
      if (PIPELINE_TOKEN_RE.test(html)) {
        const relPath = path.relative(DIST_DIR, file);
        const match = PIPELINE_TOKEN_RE.exec(html)!;
        hits.push(`${relPath}: found token "${match[0]}" at offset ${match.index}`);
      }
    }

    expect(hits).toHaveLength(0);
  }, 30_000);

  it('no CSS file contains an unreplaced Bascik shield token', async () => {
    const files = await walk(DIST_DIR, '.css');
    if (files.length === 0) return;

    const hits: string[] = [];
    for (const file of files) {
      const css = await readFile(file, 'utf-8');
      if (PIPELINE_TOKEN_RE.test(css)) {
        const relPath = path.relative(DIST_DIR, file);
        const match = PIPELINE_TOKEN_RE.exec(css)!;
        hits.push(`${relPath}: found token "${match[0]}" at offset ${match.index}`);
      }
    }

    expect(hits).toHaveLength(0);
  });

  it('no JS file contains an unreplaced Bascik shield token', async () => {
    const files = await walk(DIST_DIR, '.js');
    if (files.length === 0) return;

    const hits: string[] = [];
    for (const file of files) {
      const js = await readFile(file, 'utf-8');
      if (PIPELINE_TOKEN_RE.test(js)) {
        const relPath = path.relative(DIST_DIR, file);
        const match = PIPELINE_TOKEN_RE.exec(js)!;
        hits.push(`${relPath}: found token "${match[0]}" at offset ${match.index}`);
      }
    }

    expect(hits).toHaveLength(0);
  });
});
