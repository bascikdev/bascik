import { describe, it, expect } from 'vitest';
import { analyzeServerScriptSource } from './server-script-rules.js';

describe('Server Script Diagnostics', () => {
  describe('Contract Rules', () => {
    it('fails when server script has no export default', () => {
      const body = `const x = 1;\nlet y = 2;`;
      const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe('server-script-missing-default-export');
      expect(diags[0].severity).toBe('error');
      expect(diags[0].message).toContain('A data-bascik-server script must `export default`');
    });

    it('does not fail when hasSrcAttribute is true or export default exists', () => {
      const withExport = `export default async (request) => "<p>ok</p>";`;
      const diags1 = analyzeServerScriptSource(withExport, { hasSrcAttribute: false, directive: 'server' });
      expect(diags1.filter((d) => d.code === 'server-script-missing-default-export').length).toBe(0);

      const withSrc = ``;
      const diags2 = analyzeServerScriptSource(withSrc, { hasSrcAttribute: true, directive: 'stream' });
      expect(diags2.filter((d) => d.code === 'server-script-missing-default-export').length).toBe(0);
    });

    it('formats message correctly for stream directive', () => {
      const body = `console.log("hello");`;
      const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'stream' });
      expect(diags[0].message).toContain('A data-bascik-stream script must `export default`');
    });

    it('diagnoses missing default export for build directive', () => {
      const body = `console.log("hello");`;
      const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'build' });
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe('server-script-missing-default-export');
      expect(diags[0].message).toBe(
        'A data-bascik-build script must `export default` a function returning a string. Expected: export default async function() { ... }'
      );
    });

    it('diagnoses missing default export for routes directive', () => {
      const body = `console.log("hello");`;
      const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'routes' });
      expect(diags.length).toBe(1);
      expect(diags[0].code).toBe('server-script-missing-default-export');
      expect(diags[0].message).toBe(
        'A data-bascik-routes script must `export default` a function returning an array. Expected: export default async function() { ... }'
      );
    });

    it('recognizes various export forms and ignores export in comments/strings', () => {
      const validCases = [
        'export default async function () {}',
        'export default function () {}',
        'export default function named() {}',
        'export default async () => ""',
        'export default () => []',
        'const h = () => ""; export default h;',
        'export { handler as default };',
        'export { default } from "./helper.js";',
        'export { a, b as default } from "./helper.js";',
        'export * as default from "./helper.js";',
      ];
      for (const valid of validCases) {
        const diags = analyzeServerScriptSource(valid, { hasSrcAttribute: false, directive: 'build' });
        expect(diags.filter((d) => d.code === 'server-script-missing-default-export').length).toBe(0);
      }

      const invalidCases = [
        '// export default function () {}\nconsole.log(1);',
        '/* export default function () {} */\nconsole.log(1);',
        'const str = "export default function () {}";',
        'const tmpl = `export default function () {}`;',
        'export { default as named } from "./helper.js";',
      ];
      for (const invalid of invalidCases) {
        const diags = analyzeServerScriptSource(invalid, { hasSrcAttribute: false, directive: 'build' });
        expect(diags.filter((d) => d.code === 'server-script-missing-default-export').length).toBe(1);
      }
    });

    it('does not apply server-specific import or sink rules to build or routes', () => {
      const body = `import { escapeHtml } from '@bascik/bascik';
export default async () => \`<a href="\${request.query}"></a>\`;`;
      const diagsBuild = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'build' });
      expect(diagsBuild.length).toBe(0);

      const diagsRoutes = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'routes' });
      expect(diagsRoutes.length).toBe(0);
    });
  });

  describe('Security and Injection Sink Rules', () => {
    it('warns about unescaped interpolation in URL attributes', () => {
      const body = `
        export default async (req) => {
          return \`<a href="\${req.query}">click</a>\`;
        };
      `;
      const diags = analyzeServerScriptSource(body, { hasSrcAttribute: false, directive: 'server' });
      expect(diags.some((d) => d.code === 'server-script-sink-url-attribute')).toBe(true);
    });
  });
});
