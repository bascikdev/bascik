import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  createDiagnostics,
  createCompletions,
  createHover,
  createDefinition,
} from './analyzer.js';
import { type ProjectSnapshot } from './project.js';

describe('Bascik Language Server Analyzer', () => {
  const mockSnapshot: ProjectSnapshot = {
    projectRoot: '/test-project',
    componentRoots: ['/test-project/src/components'],
    componentMap: new Map([
      ['site-nav', '/test-project/src/components/site-nav.html'],
      ['docs-head', '/test-project/src/components/docs-head.html'],
    ]),
    componentMetadata: new Map([
      [
        'site-nav',
        {
          description: 'Top navigation bar',
          props: [{ name: 'title', description: 'Page title' }],
          slots: [{ name: 'actions', description: 'Action buttons' }],
          defaultSlot: { name: 'default', description: 'Content' },
          hasStyles: false,
          hasScripts: false,
          diagnostics: [],
        },
      ],
      [
        'docs-head',
        {
          description: 'Document head elements',
          props: [],
          slots: [],
          hasStyles: false,
          hasScripts: false,
          diagnostics: [],
        },
      ],
    ]),
    importRoot: '/test-project/src',
    htmlUsageByFile: new Map(),
  };

  it('provides component tag completions with snippets', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<site',
    );
    const completions = createCompletions(doc, { line: 0, character: 5 }, mockSnapshot);
    expect(completions).toBeDefined();
    const siteNav = completions?.find((c) => c.label === 'site-nav');
    expect(siteNav).toBeDefined();
    expect(siteNav?.insertText).toBe('<site-nav>$0</site-nav>');

    const docVoid = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<docs',
    );
    const completionsVoid = createCompletions(docVoid, { line: 0, character: 5 }, mockSnapshot);
    const docsHead = completionsVoid?.find((c) => c.label === 'docs-head');
    expect(docsHead?.insertText).toBe('<docs-head />$0');
  });

  it('provides component prop completions', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<site-nav ',
    );
    const completions = createCompletions(doc, { line: 0, character: 10 }, mockSnapshot);
    expect(completions).toBeDefined();
    const propTitle = completions?.find((c) => c.label === 'data-bascik-prop-title');
    expect(propTitle).toBeDefined();
  });

  it('provides script directive completions with updated documentation', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<script ',
    );
    const completions = createCompletions(doc, { line: 0, character: 8 }, mockSnapshot);
    expect(completions).toBeDefined();
    expect(completions?.map((c) => c.label)).toEqual([
      'data-bascik-build',
      'data-bascik-routes',
      'data-bascik-server',
      'data-bascik-stream',
    ]);
    const buildItem = completions?.find((c) => c.label === 'data-bascik-build');
    expect((buildItem?.documentation as { value: string })?.value).toContain(
      'The default exported handler function returns HTML markup that replaces this script tag in the generated HTML.'
    );
    const routesItem = completions?.find((c) => c.label === 'data-bascik-routes');
    expect((routesItem?.documentation as { value: string })?.value).toContain(
      'The default exported handler function returns an array of dynamic route parameters to generate multiple pages from a template.'
    );
  });

  it('provides script shorthand completions (<bascik-...) expanding to script blocks', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<bascik-',
    );
    const completions = createCompletions(doc, { line: 0, character: 8 }, mockSnapshot);
    expect(completions).toBeDefined();
    const buildShorthand = completions?.find((c) => c.label === 'bascik-build');
    expect(buildShorthand).toBeDefined();
    expect(buildShorthand?.insertText).toBe(
      '<script data-bascik-build>\n  export default async function () {\n    return `$0`;\n  }\n</script>'
    );

    const routesShorthand = completions?.find((c) => c.label === 'bascik-routes');
    expect(routesShorthand).toBeDefined();
    expect(routesShorthand?.insertText).toBe(
      '<script data-bascik-routes>\n  export default async function () {\n    return [\n      $0\n    ];\n  }\n</script>'
    );

    const serverShorthand = completions?.find((c) => c.label === 'bascik-server');
    expect(serverShorthand).toBeDefined();
    expect(serverShorthand?.insertText).toBe(
      '<script data-bascik-server>\n  export default async function (request, context, { signal }) {\n    return `$0`;\n  }\n</script>'
    );

    const streamShorthand = completions?.find((c) => c.label === 'bascik-stream');
    expect(streamShorthand).toBeDefined();
    expect(streamShorthand?.insertText).toBe(
      '<script data-bascik-stream>\n  export default async function (request, context, { signal }) {\n    return `$0`;\n  }\n</script>'
    );
  });

  it('provides hover documentation on components', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<site-nav></site-nav>',
    );
    const hover = createHover(doc, { line: 0, character: 3 }, mockSnapshot);
    expect(hover).toBeDefined();
    const contents = hover?.contents as { value: string };
    expect(contents.value).toContain('Top navigation bar');
    expect(contents.value).toContain('`title`: Page title');
  });

  it('diagnoses unclosed component tags', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<site-nav>',
    );
    const diags = createDiagnostics(doc, '/test-project/src/pages/index.html', mockSnapshot);
    const unclosed = diags.find((d) => d.code === 'unclosed-component-tag');
    expect(unclosed).toBeDefined();
  });

  it('diagnoses paired tag on zero-slot component', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<docs-head></docs-head>',
    );
    const diags = createDiagnostics(doc, '/test-project/src/pages/index.html', mockSnapshot);
    const zeroSlot = diags.find((d) => d.code === 'prefer-self-closing-component');
    expect(zeroSlot).toBeDefined();
  });

  it('diagnoses script directive placed on non-script tag', () => {
    const doc = TextDocument.create(
      'file:///test-project/src/pages/index.html',
      'html',
      1,
      '<div data-bascik-build></div>',
    );
    const diags = createDiagnostics(doc, '/test-project/src/pages/index.html', mockSnapshot);
    expect(diags.some((d) => d.message.includes('only valid on <script> tags'))).toBe(true);
  });
});
