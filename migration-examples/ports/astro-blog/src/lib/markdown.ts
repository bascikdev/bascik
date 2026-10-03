import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import { escapeHtml } from './site.ts';

// Equivalent of the upstream Markdown pipeline: GitHub-flavored Markdown, heading ids, and
// footnotes. A fresh Marked instance per document keeps heading-slug and footnote counters
// from leaking between posts. Syntax highlighting is deliberately not ported (see README).
export function renderMarkdown(source: string): string {
  const marked = new Marked(gfmHeadingId(), markedFootnote());
  marked.use({
    renderer: {
      // Scrollable code regions must be keyboard reachable, which the upstream highlighter
      // satisfies with tabindex="0". Marked would otherwise emit a bare <pre>.
      code({ text, lang }) {
        const language = (lang ?? '').trim().split(/\s+/)[0];
        const attribute = language ? ` class="language-${escapeHtml(language)}"` : '';
        return `<pre tabindex="0"><code${attribute}>${escapeHtml(text)}</code></pre>\n`;
      },
      image({ href, title, text }) {
        const caption = title ? ` title="${escapeHtml(title)}"` : '';
        return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${caption} loading="lazy" decoding="async">`;
      },
    },
  });
  return marked.parse(source, { async: false });
}
