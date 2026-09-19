import { describe, expect, it } from 'vitest';
import { analyzeComponentSource } from './component-metadata';

describe('analyzeComponentSource', () => {
  it('infers every prop form in source order and deduplicates names', () => {
    const metadata = analyzeComponentSource(`
      <p data-bascik-text="label"></p>
      <a data-bascik-attr-href="link" data-bascik-prop-label></a>
      <div data-bascik-html='content' data-bascik-prop-link></div>
    `);

    expect(metadata.props).toEqual([
      { name: 'label' },
      { name: 'link' },
      { name: 'content' },
    ]);
  });

  it('infers named and default slots and component features', () => {
    const metadata = analyzeComponentSource(
      `<style>.card {}</style>
       <div data-bascik-slot="actions"></div>
       <main data-bascik-slot></main>
       <script>console.log('ready')</script>`,
    );

    expect(metadata.slots).toEqual([{ name: 'actions' }]);
    expect(metadata.defaultSlot).toEqual({ name: 'default' });
    expect(metadata.hasStyles).toBe(true);
    expect(metadata.hasScripts).toBe(true);
  });

  it('recognizes companion styles', () => {
    expect(
      analyzeComponentSource('<p>Card</p>', { hasCompanionStyles: true })
        .hasStyles,
    ).toBe(true);
  });

  it('enriches inferred members from an eligible leading header', () => {
    const source = `\ufeff<!-- ordinary -->
<!-- @bascik
A documented widget.
@prop label - Visible label.
@slot actions - Action controls.
@slot default - Main widget content.
-->
<p data-bascik-prop-label></p>
<div data-bascik-slot="actions"></div>
<div data-bascik-slot></div>`;
    const metadata = analyzeComponentSource(source);

    expect(metadata.description).toBe('A documented widget.');
    expect(metadata.props).toEqual([
      { name: 'label', description: 'Visible label.' },
    ]);
    expect(metadata.slots).toEqual([
      { name: 'actions', description: 'Action controls.' },
    ]);
    expect(metadata.defaultSlot).toEqual({
      name: 'default',
      description: 'Main widget content.',
    });
    expect(metadata.diagnostics).toEqual([]);
  });

  it('ignores a metadata comment after markup', () => {
    const metadata = analyzeComponentSource(
      '<p data-bascik-prop-label></p>\n<!-- @bascik\nLate docs.\n@prop label - Ignored.\n-->',
    );
    expect(metadata.description).toBeUndefined();
    expect(metadata.props).toEqual([{ name: 'label' }]);
  });

  it('warns on undeclared and duplicate annotations with exact name offsets', () => {
    const source = `<!-- @bascik
@prop label - First.
@prop label - Second.
@prop missing - Missing.
@slot default - Missing default.
-->
<p data-bascik-prop-label></p>`;
    const metadata = analyzeComponentSource(source);

    expect(metadata.props).toEqual([
      { name: 'label', description: 'First.' },
    ]);
    expect(metadata.diagnostics.map(({ code, message }) => ({ code, message })))
      .toEqual([
        {
          code: 'component-metadata-duplicate-annotation',
          message:
            'Duplicate @prop annotation for "label". The first annotation is used.',
        },
        {
          code: 'component-metadata-undeclared-annotation',
          message:
            '@prop annotation "missing" does not match a prop declared in this component\'s markup.',
        },
        {
          code: 'component-metadata-undeclared-annotation',
          message:
            '@slot annotation "default" does not match a slot declared in this component\'s markup.',
        },
      ]);
    for (const diagnostic of metadata.diagnostics) {
      expect(source.slice(diagnostic.start, diagnostic.end)).toMatch(
        /^(?:label|missing|default)$/,
      );
    }
  });

  it('ignores prop and slot text inside comments and raw-text contents', () => {
    const metadata = analyzeComponentSource(`
      <!-- <p data-bascik-prop-commented></p> -->
      <script>const fake = '<div data-bascik-slot="fake"></div>';</script>
      <style>.x::after { content: 'data-bascik-prop-style'; }</style>
      <p data-bascik-prop-real></p>
    `);

    expect(metadata.props).toEqual([{ name: 'real' }]);
    expect(metadata.slots).toEqual([]);
  });
});
