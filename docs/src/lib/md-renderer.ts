/**
 * md-renderer.ts
 *
 * Renders a Markdown file to HTML for use inside a Bascik docs page.
 * Call this from a `data-bascik-build` script block in a page using a
 * standard relative ESM import:
 *
 *   <script data-bascik-build>
 *     import { renderMd } from '../../lib/md-renderer.ts';
 *     console.log(await renderMd('./content/16-performance.md'));
 *   </script>
 *
 * Transformations applied on top of standard marked output:
 *   - Fenced code blocks  →  <code-block data-bascik-prop-lang="..."> component
 *   - Blockquotes         →  <div class="callout">
 *
 * Because `data-bascik-build` output is processed before component resolution,
 * the emitted <code-block> tags are resolved normally by Bascik.
 */

import { readFile } from 'node:fs/promises';
import { marked } from 'marked';

interface RenderMdOptions {
  skipFirstHeading?: boolean;
  stripDemoBlocks?: boolean;
}

interface RenderRange {
  from?: string;
  to?: string;
}

/**
 * Reads a Markdown file and returns the rendered HTML string.
 *
 * @param {string} filePath - Path relative to process.cwd() (the project root).
 * @param {object} [options]
 * @param {boolean} [options.skipFirstHeading=false] - Strip the first <h1>–<h6> from
 *   the output. Useful when the page HTML shell already contains a <h1> that matches
 *   the section heading at the top of the MD file (needed for llms.txt consistency).
 */
/**
 * Extracts and HTML-escapes a specific named code block from a Markdown file.
 *
 * Code blocks are identified by an HTML comment marker placed immediately
 * before the fenced code block in the MD source:
 *
 *   <!-- demo:source-html -->
 *   ```html
 *   <div class="fcard">…</div>
 *   ```
 *
 * Use inside a `data-bascik-build` script in a slot to keep code examples
 * in MD (so they feed llms.txt / SKILL.md) rather than writing raw
 * &lt;/&gt; entities directly in the HTML page.
 *
 * @param {string} filePath - Path relative to process.cwd().
 * @param {string} markerId - The marker identifier, e.g. 'source-html'.
 * @returns {Promise<string>} HTML-escaped code ready for a <code-block> slot.
 */
export async function extractDemoBlock(filePath: string, markerId: string): Promise<string> {
  let md: string;
  try {
    md = await readFile(filePath, 'utf8');
  } catch (err) {
    console.warn(`[md-renderer] Warning: Could not read file "${filePath}": ${(err as Error).message}`);
    return `<!-- [md-renderer] File not found: ${filePath} -->`;
  }
  const markerRe = new RegExp(`<!--\\s*demo:${markerId}\\s*-->`, 'i');
  const markerMatch = markerRe.exec(md);
  if (!markerMatch) return `<!-- demo:${markerId} not found in ${filePath} -->`;

  const rest = md.slice(markerMatch.index + markerMatch[0].length);
  // Match the next fenced code block (``` ... ```)
  const codeRe = /^```\w*\n([\s\S]*?)\n^```/m;
  const codeMatch = codeRe.exec(rest);
  if (!codeMatch) return `<!-- no code block after demo:${markerId} -->`;

  return codeMatch[1]
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function renderMd(
  filePath: string,
  { skipFirstHeading = false, stripDemoBlocks = false }: RenderMdOptions = {},
): Promise<string> {
  let md: string;
  try {
    md = await readFile(filePath, 'utf8');
  } catch (err) {
    console.warn(`[md-renderer] Warning: Could not read file "${filePath}": ${(err as Error).message}`);
    return `<div class="callout"><p><strong>File not found:</strong> <code>${filePath}</code></p></div>`;
  }
  return _transformMd(md, { skipFirstHeading, stripDemoBlocks });
}

/**
 * Renders a slice of a Markdown file between two heading texts.
 *
 * @param {string} filePath
 * @param {object} [range]
 * @param {string} [range.from] - Start from this heading text (inclusive). Omit to start from file beginning.
 * @param {string} [range.to]   - Stop before this heading text (exclusive). Omit to go to end of file.
 * @param {object} [options]    - Same options as renderMd.
 */
export async function renderMdRange(
  filePath: string,
  { from, to }: RenderRange = {},
  options: RenderMdOptions = {},
): Promise<string> {
  let md: string;
  try {
    md = await readFile(filePath, 'utf8');
  } catch (err) {
    console.warn(`[md-renderer] Warning: Could not read file "${filePath}": ${(err as Error).message}`);
    return `<div class="callout"><p><strong>File not found:</strong> <code>${filePath}</code></p></div>`;
  }

  if (from) {
    const idx = _headingIndex(md, from);
    if (idx === -1) {
      throw new Error(`[md-renderer] Heading "from: ${from}" not found in ${filePath}`);
    }
    md = md.slice(idx);
  }
  if (to) {
    const idx = _headingIndex(md, to);
    if (idx === -1) {
      throw new Error(`[md-renderer] Heading "to: ${to}" not found in ${filePath}`);
    }
    md = md.slice(0, idx);
  }

  return _transformMd(md, options);
}

function _headingIndex(md: string, headingText: string): number {
  const escaped = headingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)(#{1,6} ${escaped}[ \\t]*)(?=\\n|$)`);
  const m = re.exec(md);
  if (!m) return -1;
  return m[1] === '' ? m.index : m.index + 1;
}

function _transformMd(
  md: string,
  { skipFirstHeading = false, stripDemoBlocks = false }: RenderMdOptions = {},
): string {
  if (stripDemoBlocks) {
    md = md.replace(/<!--\s*demo:[\w-]+\s*-->\n```[\w-]*\n[\s\S]*?\n```/g, '').trim();
  }

  let html = marked.parse(md, { async: false });
  // Optionally strip the first heading (h1–h6)
  if (skipFirstHeading) {
    html = html.replace(/^<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>\n?/, '');
  }

  // Add id attributes to h2 and h3 headings and wrap text in a copyable anchor link.
  html = html.replace(/<h([23])>(.*?)<\/h\1>/g, (_, level, text) => {
    const slug = text.replace(/<[^>]+>/g, '').toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    return `<h${level} id="${slug}"><a class="anchor-link" href="#${slug}">${text}</a></h${level}>`;
  });

  // Convert <pre><code class="language-X"> → <code-block data-bascik-prop-lang="X">
  // marked already HTML-escapes code content, so it passes safely into the component slot.
  html = html.replace(
    /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_, lang, code) => `<code-block data-bascik-prop-lang="${lang}">${code}</code-block>\n`
  );
  // Code blocks with no language tag
  html = html.replace(
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    (_, code) => `<code-block data-bascik-prop-lang="text">${code}</code-block>\n`
  );

  // Wrap all prose code-blocks in a spacing div so global CSS can add margin-bottom
  // without fighting bascik's component CSS scoping (which hashes .cblock class names).
  html = html.replace(
    /(<code-block[^>]*>[\s\S]*?<\/code-block>)/g,
    '<div class="prose-codeblock">$1</div>'
  );

  // Convert <blockquote> → <div class="callout">
  html = html.replace(/<blockquote>\n?/g, '<div class="callout">');
  html = html.replace(/\n?<\/blockquote>/g, '</div>');

  // Wrap all tables in <doc-table> component and ensure table header cells have scope="col"
  html = html.replace(/<th(?![^>]*\bscope=)>/g, '<th scope="col">');
  html = html.replace(/(<table[\s\S]*?<\/table>)/g, '<doc-table>$1</doc-table>');

  // Open external links in a new tab
  html = html.replace(
    /<a href="(https?:\/\/[^"]+)"/g,
    '<a target="_blank" rel="noopener noreferrer" href="$1"'
  );

  return html;
}
