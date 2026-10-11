import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('code-block component', () => {
  const componentPath = join(process.cwd(), 'src/components/code-block/code-block.html');
  const cssPath = join(process.cwd(), 'src/components/code-block/code-block.css');

  it('renders language and file props, default slot, and inline syntax highlighter', async () => {
    const html = await readFile(componentPath, 'utf8');

    expect(html).toContain('data-bascik-prop-lang');
    expect(html).toContain('data-bascik-prop-file');
    expect(html).toContain('data-bascik-slot');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('role="status" aria-live="polite"');
    expect(html).toContain('function highlight(');
  });

  // The client script assigns the highlighter's output to `innerHTML`. That is
  // safe only if every character of the source is escaped and the only markup
  // is the highlighter's own token spans. This test pins that property.
  it('highlighter output is the escaped source plus token spans, for any input', async () => {
    const html = await readFile(componentPath, 'utf8');
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf("const root = document"));
    const highlight = new Function(`${script}\nreturn highlight;`)() as (src: string, lang: string) => string | null;

    const unescape = (text: string): string =>
      text.replace(/&(lt|gt|amp);/g, (_entity, name: string) => ({ lt: '<', gt: '>', amp: '&' })[name] as string);
    const assertEscaped = (source: string, lang: string): void => {
      const output = highlight(source, lang);
      if (output === null) return;
      const text = output.replace(/<span data-code-token="[a-z]+">|<\/span>/g, '');
      expect(text, `${lang}: ${JSON.stringify(source)}`).not.toMatch(/[<>]/);
      expect(unescape(text), `${lang}: ${JSON.stringify(source)}`).toBe(source);
    };

    const corpus = [
      '<img src=x onerror=alert(1)>',
      '<script>alert(1)</script>',
      '</code><script>alert(1)</script>',
      '<!-- unterminated comment <b>',
      '<a title="<b>bold</b>" href=\'x\'>',
      '<style>p::before { content: "</style><script>x</script>" }</style>',
      '<script type="module">const s = "</script>";</script>',
      '"unterminated <img src=x onerror=1>',
      '`${"<b>"}` /* <i> */ // <u>',
      'echo "<b>" \'<i>\' $HOME # <u>',
      '{"html": "<b>&amp;</b>"}',
      '&lt;already&gt; &amp;amp;',
    ];
    const langs = ['html', 'css', 'js', 'ts', 'json', 'sh'];
    for (const lang of langs) for (const source of corpus) assertEscaped(source, lang);

    const alphabet = ['<', '>', '/', '"', "'", '`', '&', '!', '-', '*', '#', '$', '{', '}', '=', ' ', '\n', 'a', 'script', 'style'];
    let seed = 0xc0de;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed;
    };
    for (let run = 0; run < 3_000; run++) {
      let source = '';
      const length = next() % 30;
      for (let index = 0; index < length; index++) source += alphabet[next() % alphabet.length];
      assertEscaped(source, langs[run % langs.length]);
    }
  });

  it('contains sr-only / cblock-status styles for screen reader announcements', async () => {
    const css = await readFile(cssPath, 'utf8');

    expect(css).toContain('.cblock-status');
    expect(css).toContain('clip: rect(0, 0, 0, 0);');
  });
});
