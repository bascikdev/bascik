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
