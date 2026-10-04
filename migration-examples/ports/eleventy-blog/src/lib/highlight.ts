import { createRequire } from 'node:module';
import Prism from 'prismjs';
import { escapeHtml } from './site.ts';

// Equivalent of `@11ty/eleventy-plugin-syntaxhighlight`: Prism at build time, plus its
// `diff-<language>` blocks. Prism's language files expect a global `Prism`, which the
// package sets when it loads.
const require = createRequire(import.meta.url);
const components = require('prismjs/components.json') as { languages: Record<string, { alias?: string | string[] }> };

const loaded = new Set<string>();

/** Map an alias such as `js` to the Prism language name, or null when Prism has no such language. */
function canonicalName(name: string): string | null {
  if (name in components.languages && name !== 'meta') return name;
  for (const [language, info] of Object.entries(components.languages)) {
    if (language === 'meta') continue;
    const aliases = Array.isArray(info.alias) ? info.alias : info.alias ? [info.alias] : [];
    if (aliases.includes(name)) return language;
  }
  return null;
}

function ensureLanguage(name: string): boolean {
  if (loaded.has(name)) return true;
  if (!Prism.languages[name]) {
    // Loads the language and its dependencies, for example javascript needs clike.
    require('prismjs/components/index.js')(name);
  }
  if (!Prism.languages[name]) return false;
  loaded.add(name);
  return true;
}

let diffReady = false;
function ensureDiff(): void {
  if (diffReady) return;
  require('prismjs/components/prism-diff.js');
  require('prismjs/plugins/diff-highlight/prism-diff-highlight.js');
  diffReady = true;
}

/**
 * Render one fenced code block. The `<pre>` gets `tabindex="0"` so a scrolling block can be
 * reached from the keyboard. Unknown or missing languages are escaped, never executed.
 */
export function highlightCode(code: string, info: string | undefined): string {
  const written = (info ?? '').trim().split(/\s+/)[0] ?? '';
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code;
  const plain = `<pre tabindex="0"><code>${escapeHtml(trimmed)}</code></pre>\n`;
  if (!written) return plain;

  const isDiff = written.startsWith('diff-');
  const base = isDiff ? written.slice('diff-'.length) : written;
  const canonical = canonicalName(base);
  if (!canonical || !ensureLanguage(canonical)) return plain;

  let html: string;
  if (isDiff) {
    ensureDiff();
    const grammar = Prism.languages.diff;
    Prism.languages[`diff-${canonical}`] = grammar;
    html = Prism.highlight(trimmed, grammar, `diff-${canonical}`);
  } else {
    html = Prism.highlight(trimmed, Prism.languages[canonical], canonical);
  }
  const attribute = ` class="language-${escapeHtml(written)}"`;
  return `<pre${attribute} tabindex="0"><code${attribute}>${html}</code></pre>\n`;
}
