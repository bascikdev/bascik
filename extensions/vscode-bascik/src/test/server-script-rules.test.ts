import * as assert from 'node:assert';
import { analyzeServerScriptSource } from '../server-script-rules';

suite('Server Script Diagnostics', () => {
  suite('Part B: Contract Rules', () => {
    suite('server-script-missing-default-export', () => {
      test('fails when script has no export default', () => {
        const body = `const x = 1;\nlet y = 2;`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        assert.strictEqual(diags.length, 1);
        assert.strictEqual(diags[0].code, 'server-script-missing-default-export');
        assert.strictEqual(diags[0].severity, 'error');
        assert.strictEqual(diags[0].start, 0);
        assert.strictEqual(diags[0].end, 5); // 'const'
        assert.ok(diags[0].message.includes('A data-bascik-server script must `export default` a function `(request, context, { signal })`.'));
      });

      test('does not fail when hasSrcAttribute is true or export default exists', () => {
        const withExport = `export default async (request) => "<p>ok</p>";`;
        const diags1 = analyzeServerScriptSource(withExport, { hasSrcAttribute: false, directive: 'server' });
        assert.strictEqual(diags1.filter((d) => d.code === 'server-script-missing-default-export').length, 0);

        const withSrc = ``;
        const diags2 = analyzeServerScriptSource(withSrc, { hasSrcAttribute: true, directive: 'stream' });
        assert.strictEqual(diags2.filter((d) => d.code === 'server-script-missing-default-export').length, 0);
      });

      test('formats message correctly for stream directive', () => {
        const body = `console.log("hello");`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'stream' });
        assert.ok(diags[0].message.includes('A data-bascik-stream script must `export default` a function `(request, context, { signal })`.'));
      });
    });

    suite('server-script-bascik-import', () => {
      test('detects imports from @bascik/bascik or @bascik/bascik/*', () => {
        const body = `import { escapeHtml } from '@bascik/bascik';
import { helper } from "@bascik/bascik/server";
export default async () => "<p>ok</p>";`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const importDiags = diags.filter((d) => d.code === 'server-script-bascik-import');
        assert.strictEqual(importDiags.length, 2);
        assert.ok(importDiags[0].message.includes('`@bascik/bascik` exports nothing for use inside a server script.'));
        assert.ok(importDiags[0].message.includes('@/lib/server.ts'));
        assert.strictEqual(body.slice(importDiags[0].start, importDiags[0].end), '@bascik/bascik');
        assert.strictEqual(body.slice(importDiags[1].start, importDiags[1].end), '@bascik/bascik/server');
      });

      test('does not report for valid local or external module imports', () => {
        const body = `import { escape } from '@/lib/server.ts';
import sanitizeHtml from 'sanitize-html';
export default async () => "<p>ok</p>";`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        assert.strictEqual(diags.filter((d) => d.code === 'server-script-bascik-import').length, 0);
      });
    });
  });

  suite('Part C: Sink Rules', () => {
    suite('server-script-sink-url-attribute', () => {
      test('warns when placeholder is in URL attributes even if escape() is used', () => {
        const body = `export default async (request) => {
  const x = request.headers.get('referer');
  const slug = "abc";
  return \`<a href="\${x}">link</a>
<a href="\${escape(x)}">link2</a>
<a href="/static/\${slug}">link3</a>
<form action="\${x}">
<img src='\${x}'>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const urlDiags = diags.filter((d) => d.code === 'server-script-sink-url-attribute');
        assert.strictEqual(urlDiags.length, 5);
        assert.strictEqual(urlDiags[0].severity, 'warning');
        assert.ok(urlDiags[0].message.includes('URL attribute. HTML entity escaping does not neutralize `javascript:` or `data:` URLs.'));
        assert.strictEqual(body.slice(urlDiags[0].start, urlDiags[0].end), '${x}');
        assert.strictEqual(body.slice(urlDiags[1].start, urlDiags[1].end), '${escape(x)}');
        assert.strictEqual(body.slice(urlDiags[2].start, urlDiags[2].end), '${slug}');
      });
    });

    suite('server-script-sink-event-handler', () => {
      test('warns when placeholder is in event handler attributes', () => {
        const body = `export default async (request) => {
  const x = request.headers.get('x');
  return \`<div onclick="\${x}"></div><button onmouseover='\${x}'></button>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const eventDiags = diags.filter((d) => d.code === 'server-script-sink-event-handler');
        assert.strictEqual(eventDiags.length, 2);
        assert.strictEqual(eventDiags[0].severity, 'warning');
        assert.ok(eventDiags[0].message.includes('Event handler attribute. There is no safe way to interpolate untrusted data here.'));
        assert.strictEqual(body.slice(eventDiags[0].start, eventDiags[0].end), '${x}');
      });
    });

    suite('server-script-sink-unquoted-attribute', () => {
      test('warns when placeholder is in unquoted attributes but not quoted attributes', () => {
        const body = `export default async (request) => {
  const x = request.headers.get('x');
  return \`<p class=\${x}></p><div id="\${x}"></div>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const unquotedDiags = diags.filter((d) => d.code === 'server-script-sink-unquoted-attribute');
        assert.strictEqual(unquotedDiags.length, 1);
        assert.strictEqual(unquotedDiags[0].severity, 'warning');
        assert.ok(unquotedDiags[0].message.includes('Unquoted attribute. A space in the value breaks out of the attribute. Quote it: `attr="${...}"`.'));
        assert.strictEqual(body.slice(unquotedDiags[0].start, unquotedDiags[0].end), '${x}');
      });
    });

    suite('server-script-sink-inline-script', () => {
      test('warns when placeholder is in an unclosed <script> block within literal', () => {
        const body = `export default async () => {
  const json = "{}";
  const x = "text";
  return \`<script>window.data = \${json};</script><script>const y = \${json};</script><script>...</script><p>\${x}</p>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const scriptDiags = diags.filter((d) => d.code === 'server-script-sink-inline-script');
        assert.strictEqual(scriptDiags.length, 2);
        assert.strictEqual(scriptDiags[0].severity, 'warning');
        assert.ok(scriptDiags[0].message.includes('Inline `<script>` body. Entity escaping does not apply in JavaScript context.'));
        assert.strictEqual(body.slice(scriptDiags[0].start, scriptDiags[0].end), '${json}');
      });
    });

    suite('server-script-sink-style', () => {
      test('warns when placeholder is in a style attribute or <style> tag', () => {
        const body = `export default async () => {
  const c = "red";
  return \`<div style="color:\${c}"></div><style>.box { color: \${c}; }</style>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const styleDiags = diags.filter((d) => d.code === 'server-script-sink-style');
        assert.strictEqual(styleDiags.length, 2);
        assert.strictEqual(styleDiags[0].severity, 'warning');
        assert.ok(styleDiags[0].message.includes('CSS context. Do not interpolate untrusted data into styles.'));
        assert.strictEqual(body.slice(styleDiags[0].start, styleDiags[0].end), '${c}');
      });
    });

    suite('server-script-sink-text-unescaped', () => {
      test('reports info when unescaped request-derived data is interpolated in text context', () => {
        const body = `export default async (request) => {
  return \`<p>\${request.headers.get('x')}</p>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const textDiags = diags.filter((d) => d.code === 'server-script-sink-text-unescaped');
        assert.strictEqual(textDiags.length, 1);
        assert.strictEqual(textDiags[0].severity, 'info');
        assert.ok(textDiags[0].message.includes('Untrusted request value interpolated without an escaping function. Wrap it, for example `escape(value)` from your `@/lib/server.ts`.'));
        assert.strictEqual(body.slice(textDiags[0].start, textDiags[0].end), "${request.headers.get('x')}");
      });

      test('does not report for call-wrapped expressions or non-request data', () => {
        const body = `export default async (request, context) => {
  const row = { title: "Hello" };
  return \`<p>\${escape(request.headers.get('x'))}</p><p>\${row.title}</p>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        const textDiags = diags.filter((d) => d.code === 'server-script-sink-text-unescaped');
        assert.strictEqual(textDiags.length, 0);
      });

      test('skips placeholders inside HTML comments <!-- ... -->', () => {
        const body = `export default async (request) => {
  return \`<!-- \${request.headers.get('x')} --><p>Clean</p>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        assert.strictEqual(diags.filter((d) => d.code.startsWith('server-script-sink-')).length, 0);
      });

      test('clean script from docs yields zero diagnostics', () => {
        const body = `import { escape } from '@/lib/server.ts';

export default async (request, context, { signal }) => {
  const user = escape(request.headers.get('x-user') ?? 'guest');
  return \`<p>Hello \${user}</p>\`;
};`;
        const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
        assert.strictEqual(diags.length, 0);
      });
    });
  });
});

