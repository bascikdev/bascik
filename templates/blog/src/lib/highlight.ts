import { createRequire } from 'node:module';
import Prism from 'prismjs';
import { escapeHtml } from './format.ts';

// Build-time syntax highlighting with Prism. Nothing runs in the browser; token colors are in
// src/css/global.css. Prism's language files expect a global `Prism`, which the package sets
// when it loads.
const require = createRequire(import.meta.url);
const components = require('prismjs/components.json') as { languages: Record<string, { alias?: string | string[] }> };

/** Map a name or alias such as `js` to the Prism language, or null when Prism has no such language. */
function canonicalName(name: string): string | null {
  if (name === 'meta') return null;
  if (name in components.languages) return name;
  for (const [language, info] of Object.entries(components.languages)) {
    if (language === 'meta') continue;
    const aliases = Array.isArray(info.alias) ? info.alias : info.alias ? [info.alias] : [];
    if (aliases.includes(name)) return language;
  }
  return null;
}

function ensureLanguage(name: string): boolean {
  if (!Prism.languages[name]) {
    // Loads the language and its dependencies (javascript needs clike, for example).
    require('prismjs/components/index.js')(name);
  }
  return Boolean(Prism.languages[name]);
}

/**
 * Render one fenced code block. The `<pre>` gets `tabindex="0"` so a block that scrolls sideways
 * can be reached from the keyboard. Unknown or missing languages are escaped, never executed.
 */
export function highlightCode(code: string, info: string | undefined): string {
  const written = (info ?? '').trim().split(/\s+/)[0] ?? '';
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code;
  const plain = `<pre tabindex="0"><code>${escapeHtml(trimmed)}</code></pre>\n`;
  if (!written) return plain;
  const canonical = canonicalName(written);
  if (!canonical || !ensureLanguage(canonical)) return plain;
  const grammar = Prism.languages[canonical];
  if (!grammar) return plain;
  const html = Prism.highlight(trimmed, grammar, canonical);
  const attribute = ` class="language-${escapeHtml(canonical)}"`;
  return `<pre${attribute} tabindex="0"><code${attribute}>${html}</code></pre>\n`;
}
