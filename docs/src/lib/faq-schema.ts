/**
 * Generates a FAQPage JSON-LD script tag from a Markdown file.
 * Parses every ## heading as a question and the following text as the answer.
 *
 * Usage inside a <script data-bascik-build> block:
 *
 *   const { faqSchema } = await import(
 *     pathToFileURL(join(process.cwd(), 'src/lib/faq-schema.ts')).href
 *   );
 *   console.log(await faqSchema('content/faq.md'));
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function stripMd(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // [text](url) → text
    .replace(/`([^`]+)`/g, '$1')               // `code` → code
    .replace(/\*\*([^*]+)\*\*/g, '$1')         // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')             // *italic* → italic
    .replace(/</g, '&lt;')                     // < → &lt;
    .replace(/>/g, '&gt;');                    // > → &gt;
}

export async function faqSchema(mdPath: string): Promise<string> {
  let md: string;
  try {
    md = await readFile(join(process.cwd(), mdPath), 'utf8');
  } catch (err) {
    console.warn(`[faq-schema] Warning: Could not read file "${mdPath}": ${(err as Error).message}`);
    return '';
  }

  // Split on ## headings; first element is the preamble before any ##
  const sections = md.split(/^## /m).slice(1);
  const pairs: Array<{ question: string; answer: string }> = [];

  for (const section of sections) {
    const newline = section.indexOf('\n');
    const question = stripMd(section.slice(0, newline).trim());

    // Strip fenced code blocks, then blockquotes, then normalize whitespace
    const body = section.slice(newline + 1)
      .replace(/```[\s\S]*?```/gm, '')
      .replace(/^> .*/gm, '')
      .trim();

    const answer = stripMd(body).replace(/\n{3,}/g, '\n\n').trim();
    if (question && answer) pairs.push({ question, answer });
  }

  if (pairs.length === 0) return '';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };

  return `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2).replace(/</g, '\\u003c')}\n</script>`;
}
