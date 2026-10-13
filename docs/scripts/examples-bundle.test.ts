// Unit tests for the examples bundle (examples-bundle.ts), the page helpers (src/lib/examples.ts), and a guard that
// every example component is documented and exercised. Browser behavior is in e2e/examples.spec.ts.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNDLE_VERSION, DOCUMENTED_WITH, componentDescription, componentTagsIn, createExamplesBundle, readmeDescription, titleOf } from './examples-bundle.ts';
import { fileTree, githubUrl } from '../src/lib/examples.ts';
import { NAV } from '../src/lib/nav.ts';

const docsRoot = fileURLToPath(new URL('..', import.meta.url));
const examplesDir = join(docsRoot, '../examples');
const componentNames = readdirSync(join(examplesDir, 'components')).sort();


describe('examples-bundle helpers', () => {
  it('titles names and reads descriptions from @bascik comments and READMEs', () => {
    expect(titleOf('tab-group')).toBe('Tab Group');
    expect(componentDescription('<!-- @bascik\n  Shows tabs.\n  Two lines.\n\n  More.\n  @prop x -->')).toBe('Shows tabs. Two lines.');
    expect(componentDescription('<div></div>')).toBe('');
    expect(readmeDescription('# Title\n\n```sh\nx\n```\n\nA site\nwith posts.\n\nMore.')).toBe('A site with posts.');
  });

  it('finds component tags in markup, ignoring comments, unknown tags, and the component itself', () => {
    const names = new Set(['tab-group', 'copy-button']);
    const source = '<!-- <copy-button> --><tab-group></tab-group><other-thing></other-thing><copy-button>';
    expect(componentTagsIn(source, names)).toEqual(['copy-button', 'tab-group']);
    expect(componentTagsIn(source, names, 'tab-group')).toEqual(['copy-button']);
  });
});

describe('examples page helpers', () => {
  it('prints folders before files at each level', () => {
    expect(fileTree('site', ['b.txt', 'src/z.ts', 'a.txt', 'src/lib/x.ts'])).toBe(
      ['site/', '  src/', '    lib/', '      x.ts', '    z.ts', '  a.txt', '  b.txt'].join('\n'),
    );
  });

  it('links to the example on GitHub', () => {
    expect(githubUrl('components/tab-group')).toBe('https://github.com/bascikdev/bascik/tree/main/examples/components/tab-group');
  });
});

describe('the published bundle', async () => {
  const bundle = await createExamplesBundle(examplesDir);
  const byName = new Map(bundle.examples.map((example) => [example.name, example]));

  it('has every component and site, each with a description and files', () => {
    expect(bundle.version).toBe(BUNDLE_VERSION);
    expect(bundle.examples.filter((e) => e.kind === 'component').map((e) => e.name)).toEqual(componentNames);
    expect(byName.get('starter-site')).toMatchObject({ kind: 'site', docs: 'https://github.com/bascikdev/bascik/tree/main/examples/starter-site' });
    expect(byName.get('theme-init')?.docs).toBe('/example-components/theme-toggle');
    for (const example of bundle.examples) {
      expect(example.description, example.name).not.toBe('');
      expect(example.files.length, example.name).toBeGreaterThan(0);
    }
  });

  it('records the components a site file uses, including components from the site itself', () => {
    const contact = byName.get('starter-site')!.files.find((file) => file.path === 'src/pages/contact.html')!;
    expect(contact.uses).toContain('contact-form');
    expect(contact.uses).toContain('site-head');
  });

  it('never ships build output or dependencies', () => {
    const paths = bundle.examples.flatMap((example) => example.files.map((file) => `${example.name}/${file.path}`));
    expect(paths.filter((path) => /(^|\/)(node_modules|dist|\.[^/]+)\//.test(path))).toEqual([]);
  });
});

describe('every example component is documented and exercised', () => {
  const navHrefs = new Set(NAV.flatMap((section) => section.pages.map((page) => page.href)));
  const testPage = readFileSync(join(docsRoot, 'e2e/fixtures/example-components.html'), 'utf8');

  it.each(componentNames)('%s', (name) => {
    const page = DOCUMENTED_WITH[name] ?? name;
    expect(existsSync(join(docsRoot, `src/pages/example-components/${page}.html`)), `add src/pages/example-components/${page}.html`).toBe(true);
    expect(existsSync(join(docsRoot, `content/example-components/${page}.md`)), `add content/example-components/${page}.md`).toBe(true);
    expect(navHrefs.has(`/example-components/${page}`), `add /example-components/${page} to nav.ts`).toBe(true);
    if (!DOCUMENTED_WITH[name]) {
      const instances = testPage.match(new RegExp(`<${name}\\b`, 'g'))?.length ?? 0;
      expect(instances, `put two <${name}> instances in e2e/fixtures/example-components.html`).toBeGreaterThanOrEqual(2);
    }
  });
});
