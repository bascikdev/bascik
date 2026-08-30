/**
 * W3C CSS Selectors & CSS2.1 Conformance Test Suite
 *
 * Grounded in:
 * - W3C CSS3 Selectors Test Suite (https://www.w3.org/Style/CSS/Test/CSS3/Selectors/current/)
 * - W3C CSS2.1 Conformance Test Suite (https://www.w3.org/Style/CSS/Test/CSS2.1/20110323/)
 * - W3C CSS Snapshot 2026 §2.1 [CSS2, SELECTORS-3] & §2.4 [SELECTORS-4, CSS-NESTING-1]
 * - WPT Selectors & Nesting Test Suites (https://wpt.live/css/selectors/, https://wpt.live/css/css-nesting/)
 *
 * Validates that Bascik correctly transforms element selectors, pseudo-classes,
 * pseudo-elements, attribute selectors, combinators, and nested rules into
 * isolated component scopes with elevated class specificity ((0,0,1) -> (0,1,0)).
 */
import { describe, it, expect } from 'vitest';
import {
  convertCssElementSelectorsToClasses,
  convertCssIdSelectorsToClasses,
  scopeInlineStyleTags,
  addElementClassesInHtml,
  addIdClassesInHtml,
} from './styles.ts';

describe('W3C CSS Selectors & CSS2.1 Conformance', () => {
  const componentName = 'selector-box';

  describe('1. Structural Pseudo-Classes (W3C Selectors 3 & 4)', () => {
    it('scopes element selectors with structural pseudo-classes (:first-child, :last-child, :only-child, :empty)', () => {
      const inputCss = `
        li:first-child { font-weight: bold; }
        li:last-child { border-bottom: none; }
        p:only-child { margin: 0; }
        div:empty { display: none; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__li:first-child`);
      expect(scoped).toContain(`.bascik__${componentName}__el__li:last-child`);
      expect(scoped).toContain(`.bascik__${componentName}__el__p:only-child`);
      expect(scoped).toContain(`.bascik__${componentName}__el__div:empty`);
    });

    it('scopes nth-child and nth-of-type expressions (:nth-child(2n+1), :nth-last-child(odd), :nth-of-type(3))', () => {
      const inputCss = `
        tr:nth-child(2n+1) { background: #fafafa; }
        tr:nth-child(odd) { color: #111; }
        tr:nth-child(even) { color: #222; }
        tr:nth-last-child(-n+2) { font-style: italic; }
        td:first-of-type { text-align: left; }
        td:last-of-type { text-align: right; }
        td:only-of-type { width: 100%; }
        span:nth-of-type(3n) { color: blue; }
        span:nth-last-of-type(2) { color: green; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__tr:nth-child(2n+1)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__tr:nth-child(odd)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__tr:nth-child(even)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__tr:nth-last-child(-n+2)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__td:first-of-type`);
      expect(scoped).toContain(`.bascik__${componentName}__el__td:last-of-type`);
      expect(scoped).toContain(`.bascik__${componentName}__el__td:only-of-type`);
      expect(scoped).toContain(`.bascik__${componentName}__el__span:nth-of-type(3n)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__span:nth-last-of-type(2)`);
    });

    it('scopes Selectors 4 :nth-child(An+B of selector) syntax', () => {
      const inputCss = `
        li:nth-child(even of .highlight) { background: yellow; }
        tr:nth-child(2n+1 of :not(.hidden)) { opacity: 1; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__li:nth-child(even of .highlight)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__tr:nth-child(2n+1 of :not(.hidden))`);
    });
  });

  describe('2. Negation, Relational & Selector Lists (:not, :is, :where, :has)', () => {
    it('scopes element selectors containing :not(...) and modern functional pseudo-classes', () => {
      const inputCss = `
        p:not(.lead) { font-size: 1rem; }
        button:not([disabled]) { cursor: pointer; }
        article:has(img) { grid-column: span 2; }
        section:is(.hero, .banner) { padding: 4rem 2rem; }
        header:where(.main-nav, .sub-nav) { display: flex; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__p:not(.lead)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__button:not([disabled])`);
      expect(scoped).toContain(`.bascik__${componentName}__el__article:has(img)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__section:is(.hero, .banner)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__header:where(.main-nav, .sub-nav)`);
    });
  });

  describe('3. Dynamic, UI State & Language Pseudo-Classes', () => {
    it('scopes UI states and interaction selectors (:hover, :focus, :focus-visible, :focus-within, :checked, :disabled)', () => {
      const inputCss = `
        a:link { color: #0066cc; }
        a:visited { color: #800080; }
        a:hover { text-decoration: underline; }
        a:active { color: #cc0000; }
        button:focus-visible { outline: 2px solid blue; }
        form:focus-within { border-color: highlight; }
        input:enabled { opacity: 1; }
        input:disabled { opacity: 0.5; cursor: not-allowed; }
        input:checked + label { font-weight: bold; }
        input:indeterminate { opacity: 0.75; }
        input:required { border-left: 3px solid red; }
        input:optional { border-left: 1px solid gray; }
        input:valid { border-color: green; }
        input:invalid { border-color: red; }
        div:target { background: yellow; }
        p:lang(fr) { quotes: "«" "»"; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__a:link`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a:visited`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a:hover`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a:active`);
      expect(scoped).toContain(`.bascik__${componentName}__el__button:focus-visible`);
      expect(scoped).toContain(`.bascik__${componentName}__el__form:focus-within`);
      expect(scoped).toContain(`.bascik__${componentName}__el__input:enabled`);
      expect(scoped).toContain(`.bascik__${componentName}__el__input:disabled`);
      expect(scoped).toContain(`.bascik__${componentName}__el__input:checked + .bascik__${componentName}__el__label`);
      expect(scoped).toContain(`.bascik__${componentName}__el__input:required`);
      expect(scoped).toContain(`.bascik__${componentName}__el__div:target`);
      expect(scoped).toContain(`.bascik__${componentName}__el__p:lang(fr)`);
    });
  });

  describe('4. Attribute Selectors (W3C Selectors 3 & 4)', () => {
    it('scopes element selectors with presence, exact, and substring attribute matchers', () => {
      const inputCss = `
        a[href] { text-decoration: underline; }
        a[target="_blank"] { font-weight: bold; }
        a[rel~="external"] { color: orange; }
        a[hreflang|="en"] { color: blue; }
        a[href^="https://"] { padding-left: 16px; }
        a[href$=".pdf"] { background-image: url('pdf.svg'); }
        a[href*="w3.org"] { color: #005a9c; }
        input[type="text" i] { padding: 4px; }
        input[type="TEXT" s] { border: 1px solid red; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__a[href]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a[target="_blank"]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a[rel~="external"]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a[hreflang|="en"]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a[href^="https://"]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a[href$=".pdf"]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a[href*="w3.org"]`);
      expect(scoped).toContain(`.bascik__${componentName}__el__input[type="text" i]`);
    });
  });

  describe('5. Combinators & Complex Selectors (W3C CSS2.1 & Selectors 3/4)', () => {
    it('scopes descendant, child (>), adjacent sibling (+), and general sibling (~) combinators', () => {
      const inputCss = `
        div span { color: red; }
        ul > li { list-style: square; }
        h2 + p { font-size: 1.2rem; }
        h2 ~ p { line-height: 1.6; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__div .bascik__${componentName}__el__span`);
      expect(scoped).toContain(`.bascik__${componentName}__el__ul > .bascik__${componentName}__el__li`);
      expect(scoped).toContain(`.bascik__${componentName}__el__h2 + .bascik__${componentName}__el__p`);
      expect(scoped).toContain(`.bascik__${componentName}__el__h2 ~ .bascik__${componentName}__el__p`);
    });

    it('preserves pseudo-elements (::before, ::after, ::first-line, ::first-letter, ::selection, ::placeholder)', () => {
      const inputCss = `
        blockquote::before { content: "“"; }
        blockquote::after { content: "”"; }
        p::first-line { font-weight: bold; }
        p::first-letter { font-size: 200%; }
        ::selection { background: #d3ff8d; color: black; }
        input::placeholder { color: #999; }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__blockquote::before`);
      expect(scoped).toContain(`.bascik__${componentName}__el__blockquote::after`);
      expect(scoped).toContain(`.bascik__${componentName}__el__p::first-line`);
      expect(scoped).toContain(`.bascik__${componentName}__el__p::first-letter`);
      expect(scoped).toContain('::selection { background: #d3ff8d; color: black; }');
      expect(scoped).toContain(`.bascik__${componentName}__el__input::placeholder`);
    });
  });

  describe('6. W3C CSS Nesting Module (2023 Relaxed Syntax)', () => {
    it('scopes explicit & nesting and 2023 relaxed direct nesting without &', () => {
      const inputCss = `
        .card {
          padding: 1rem;
          & h2 { margin-top: 0; }
          & > p { color: #444; }
          & + .card { margin-top: 1rem; }
          & ~ .card { opacity: 0.9; }
          p { margin-bottom: 0.5rem; }
          > span { font-weight: bold; }
          + hr { border: none; }
        }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain(`& .bascik__${componentName}__el__h2`);
      expect(scoped).toContain(`& > .bascik__${componentName}__el__p`);
      expect(scoped).toContain('& + .card');
      expect(scoped).toContain('& ~ .card');
      expect(scoped).toContain(`.bascik__${componentName}__el__p { margin-bottom: 0.5rem; }`);
      expect(scoped).toContain(`> .bascik__${componentName}__el__span`);
      expect(scoped).toContain(`+ .bascik__${componentName}__el__hr`);
    });
  });

  describe('7. End-to-End Element & ID Class Injection in HTML', () => {
    it('accurately injects converted element classes into matching HTML tags without corrupting substrings', () => {
      const inputHtml = `
        <article class="post">
          <h2>Article Title</h2>
          <p>Paragraph with <a href="#">link</a> and <span>inline span</span>.</p>
          <aside>Sidebar note</aside>
        </article>
      `;
      const convertedElements = ['article', 'h2', 'p', 'a', 'span', 'aside'];
      const resultHtml = addElementClassesInHtml(inputHtml, componentName, convertedElements);

      expect(resultHtml).toContain(`<article class="post bascik__${componentName}__el__article">`);
      expect(resultHtml).toContain(`<h2 class="bascik__${componentName}__el__h2">Article Title</h2>`);
      expect(resultHtml).toContain(`<p class="bascik__${componentName}__el__p">`);
      expect(resultHtml).toContain(`<a class="bascik__${componentName}__el__a" href="#">link</a>`);
      expect(resultHtml).toContain(`<span class="bascik__${componentName}__el__span">inline span</span>`);
      expect(resultHtml).toContain(`<aside class="bascik__${componentName}__el__aside">Sidebar note</aside>`);
    });

    it('converts ID selectors to classes for per-instance scoping (#id -> .bascik__comp__id__name)', () => {
      const inputCss = `
        #main-btn { background: green; }
        #hero-title { font-size: 2rem; }
      `;
      const { css: scopedCss, idsConverted } = convertCssIdSelectorsToClasses(inputCss, componentName);

      expect(scopedCss).toContain(`.bascik__${componentName}__id__main-btn { background: green; }`);
      expect(scopedCss).toContain(`.bascik__${componentName}__id__hero-title { font-size: 2rem; }`);
      expect(idsConverted).toEqual([
        { idName: 'main-btn', className: `bascik__${componentName}__id__main-btn` },
        { idName: 'hero-title', className: `bascik__${componentName}__id__hero-title` },
      ]);

      const inputHtml = '<button id="main-btn" class="btn">Click</button>';
      const resultHtml = addIdClassesInHtml(inputHtml, idsConverted);
      expect(resultHtml).toContain(`class="btn bascik__${componentName}__id__main-btn"`);
    });
  });
});
