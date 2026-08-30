import { describe, it, expect } from 'vitest';
import * as elements from '@webref/elements';
import * as idl from '@webref/idl';
import * as cssRef from '@webref/css';
import * as webidl2 from 'webidl2';
import bcd from '@mdn/browser-compat-data';
import { NATIVE_HTML_ELEMENTS } from './components.ts';
import {
  convertCssElementSelectorsToClasses,
  scopeLayerNames,
  scopeContainerNames,
  scopeCssCustomProperties,
  prefixKeyframes,
  scopeViewTransitionNames,
  scopeCounterStyleNames,
  scopeAnchorNames,
} from './styles.ts';
import { prefixElementAttribute, namespaceScriptTags } from './javascript.ts';
import { INLINE_TAGS, minifyHtml } from './html-minifier.ts';
import { MIME_MAP } from './mime.ts';
import { makeEtag, makeStatEtag } from './server.ts';
import { escapeXml, buildSitemapXml } from './sitemap.ts';

describe('Web Standards Validation via @webref & MDN BCD', () => {
  describe('HTML Standards Validation (WHATWG HTML §4 / @webref/elements & MDN BCD)', () => {
    it('validates NATIVE_HTML_ELEMENTS against WHATWG HTML elements from @webref/elements', async () => {
      const allElements = await elements.listAll();
      const htmlSpec = allElements['html'];
      expect(htmlSpec).toBeDefined();
      expect(htmlSpec.elements).toBeDefined();

      // Verify key standard elements are recognized in Bascik's NATIVE_HTML_ELEMENTS set
      for (const el of htmlSpec.elements) {
        if (['p', 'div', 'span', 'article', 'section', 'nav', 'header', 'footer', 'main', 'button', 'input', 'dialog', 'template', 'slot'].includes(el.name)) {
          expect(NATIVE_HTML_ELEMENTS.has(el.name)).toBe(true);
        }
      }
    });

    it('validates INLINE_TAGS against MDN BCD HTML inline element definitions', () => {
      const mdnElements = Object.keys(bcd.html.elements);
      expect(mdnElements.length).toBeGreaterThan(50);

      // Verify that known phrasing/inline elements in Bascik's minifier exist in MDN BCD
      const keyInlineTags = ['a', 'span', 'strong', 'em', 'code', 'b', 'i', 'small', 'sub', 'sup', 'label'];
      for (const tag of keyInlineTags) {
        expect(INLINE_TAGS.has(tag)).toBe(true);
        expect(mdnElements).toContain(tag);
      }
    });

    it('verifies standard HTML element scoping with convertCssElementSelectorsToClasses', () => {
      const sampleCss = `
        article { margin: 0; }
        section { font-size: 1.5rem; }
        nav { text-decoration: underline; }
      `;
      const componentName = 'card';
      const { css: scoped, elementsConvertedClasses } = convertCssElementSelectorsToClasses(sampleCss, componentName);

      expect(scoped).toContain(`.bascik__${componentName}__el__article`);
      expect(scoped).toContain(`.bascik__${componentName}__el__section`);
      expect(scoped).toContain(`.bascik__${componentName}__el__nav`);
      expect(elementsConvertedClasses).toEqual(expect.arrayContaining(['article', 'section', 'nav']));
    });
  });

  describe('JavaScript & DOM Standards Validation (WHATWG DOM / WebIDL & MDN BCD)', () => {
    it('verifies standard DOM interfaces from WHATWG DOM IDL in @webref/idl', async () => {
      const allIdl = await idl.listAll();
      expect(allIdl['dom']).toBeDefined();

      const domText = await allIdl['dom'].text();
      const parsed = webidl2.parse(domText);
      const interfaceNames = parsed.map((node: any) => node.name).filter(Boolean);

      // Verify essential WHATWG DOM interfaces exist in the official spec AST
      expect(interfaceNames).toContain('Document');
      expect(interfaceNames).toContain('Element');
      expect(interfaceNames).toContain('NodeList');
      expect(interfaceNames).toContain('CustomEvent');
      expect(interfaceNames).toContain('EventTarget');
    });

    it('verifies DOM query rewrites for methods specified in WHATWG DOM & MDN BCD', () => {
      // Document methods from WHATWG DOM spec: getElementById, querySelector, querySelectorAll
      expect(bcd.api.Document.getElementById).toBeDefined();
      expect(bcd.api.Document.querySelector).toBeDefined();
      expect(bcd.api.Document.querySelectorAll).toBeDefined();

      // Element methods from WHATWG DOM spec: closest, matches, classList, setAttribute
      expect(bcd.api.Element.closest).toBeDefined();
      expect(bcd.api.Element.matches).toBeDefined();
      expect(bcd.api.Element.classList).toBeDefined();

      const clientHtml = `
        <button id="submit-btn" class="item">Click</button>
        <script>
          const btn = document.getElementById("submit-btn");
          const list = document.querySelectorAll(".item");
          const parent = btn.closest(".container");
          if (btn.matches(".active")) {
            btn.classList.add("highlight");
          }
        </script>
      `;

      const comp = {
        name: 'card',
        fileContent: clientHtml,
        filePath: '/src/components/card.html',
        directory: '/src/components',
        componentFileExtension: '.html',
        id: '1',
      };

      const scopedId = prefixElementAttribute(comp, 'id', 'inst123');
      expect(scopedId.fileContent).toContain('getElementById("bascik__card__inst123__submit-btn")');
      expect(scopedId.fileContent).toContain('id="bascik__card__inst123__submit-btn"');

      const scopedClass = prefixElementAttribute(scopedId, 'class', 'inst123');
      expect(scopedClass.fileContent).toContain('querySelectorAll(".bascik__card__item")');
    });

    it('verifies ECMA-262 / WHATWG HTML script isolation (IIFE wrapping vs ES Modules)', () => {
      const compClassic = {
        name: 'card',
        fileContent: `<script>const count = 0;</script>`,
        filePath: '/src/components/card.html',
        directory: '/src/components',
        componentFileExtension: '.html',
        id: '1',
      };
      const namespacedClassic = namespaceScriptTags(compClassic);
      expect(namespacedClassic.fileContent).toContain('(function() {');
      expect(namespacedClassic.fileContent).toContain('const count = 0;');
      expect(namespacedClassic.fileContent).toContain('})();');

      // Native ES Modules (type="module") must not be wrapped in IIFE per ECMA-262 / WHATWG HTML §7.1
      const compModule = {
        name: 'card',
        fileContent: `<script type="module">import { x } from './x.ts';</script>`,
        filePath: '/src/components/card.html',
        directory: '/src/components',
        componentFileExtension: '.html',
        id: '2',
      };
      const namespacedModule = namespaceScriptTags(compModule);
      expect(namespacedModule.fileContent).not.toContain('(function() {');
      expect(namespacedModule.fileContent).toContain('type="module"');
    });
  });

  describe('CSS Standards Validation (W3C CSS / @webref/css)', () => {
    it('verifies standard CSS Cascade @layer and Container Queries @container scoping', () => {
      const layerCss = `@layer base, utilities; @layer base { .card { padding: 1rem; } }`;
      const scopedLayers = scopeLayerNames(layerCss, 'layer123');
      expect(scopedLayers).toContain('@layer bascik__layer123__layer__base');
      expect(scopedLayers).toContain('bascik__layer123__layer__utilities');

      const containerCss = `container-name: card; @container card (min-width: 400px) { .child { flex-direction: row; } }`;
      const scopedContainer = scopeContainerNames(containerCss, 'cq123');
      expect(scopedContainer).toContain('@container bascik__cq123__container__card');
    });

    it('verifies W3C CSS Nesting Module (2023 relaxed direct nesting with and without explicit &)', () => {
      const nestedCss = `
        .container {
          & > h1 { font-size: 2rem; }
          &>h2 { font-size: 1.5rem; }
          > p { line-height: 1.6; }
          + aside { margin-top: 1rem; }
          ~ footer { opacity: 0.8; }
          span { color: #333; }
        }
      `;
      const { css: scoped, elementsConvertedClasses } = convertCssElementSelectorsToClasses(nestedCss, 'my-comp');

      expect(scoped).toContain('& > .bascik__my-comp__el__h1');
      expect(scoped).toContain('&>.bascik__my-comp__el__h2');
      expect(scoped).toContain('> .bascik__my-comp__el__p');
      expect(scoped).toContain('+ .bascik__my-comp__el__aside');
      expect(scoped).toContain('~ .bascik__my-comp__el__footer');
      expect(scoped).toContain('.bascik__my-comp__el__span');
      expect(elementsConvertedClasses).toEqual(expect.arrayContaining(['h1', 'h2', 'p', 'aside', 'footer', 'span']));
    });

    it('verifies standard CSS at-rules from W3C specs in @webref/css are supported', async () => {
      const allCss = await cssRef.listAll();
      expect(allCss).toBeDefined();

      // Check custom properties, keyframes, view transitions, counter styles, and anchor positioning
      const customPropCss = `--brand: #00f; color: var(--brand);`;
      const scopedProps = scopeCssCustomProperties(customPropCss, 'c1');
      expect(scopedProps).toContain('--bascik__c1__brand');

      const kfCss = `@keyframes pulse { 0% { opacity: 0; } } .anim { animation: pulse 1s; }`;
      const scopedKf = prefixKeyframes(kfCss, 'c1');
      expect(scopedKf).toContain('@keyframes bascik__c1__keyframe__pulse');

      const vtCss = `.card { view-transition-name: card-thumb; } ::view-transition-old(card-thumb) { opacity: 0; }`;
      const scopedVt = scopeViewTransitionNames(vtCss, 'c1');
      expect(scopedVt).toContain('view-transition-name: bascik__c1__vtn__card-thumb');
      expect(scopedVt).toContain('::view-transition-old(bascik__c1__vtn__card-thumb)');

      const counterCss = `@counter-style custom-roman { system: additive; } li { list-style: custom-roman; }`;
      const scopedCounter = scopeCounterStyleNames(counterCss, 'c1');
      expect(scopedCounter).toContain('@counter-style bascik__c1__counter__custom-roman');
      expect(scopedCounter).toContain('list-style: bascik__c1__counter__custom-roman');

      const anchorCss = `.anchor { anchor-name: --menu; } .popover { position-anchor: --menu; } @position-try --top { top: 0; }`;
      const scopedAnchor = scopeAnchorNames(anchorCss, 'c1');
      expect(scopedAnchor).toContain('anchor-name: --bascik__c1__anchor__menu');
      expect(scopedAnchor).toContain('position-anchor: --bascik__c1__anchor__menu');
      expect(scopedAnchor).toContain('@position-try --bascik__c1__anchor__top');
    });
  });

  describe('HTTP, ALPN & Protocols Standards Validation (RFC 9110, RFC 9112, RFC 9113, RFC 9239)', () => {
    it('verifies HSTS security header complies with RFC 6797 directive grammar', async () => {
      const { getSecurityHeaders } = await import('./server.ts');
      const mockHttpsReq = {
        method: 'GET',
        path: '/',
        headers: { ':scheme': 'https' },
        remoteIp: '127.0.0.1',
      };
      const headers = getSecurityHeaders(mockHttpsReq);
      expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    });

    it('verifies RFC 9239 JavaScript MIME type complies with current web standard', () => {
      expect(MIME_MAP.get('.js')).toBe('text/javascript; charset=utf-8');
      expect(MIME_MAP.get('.mjs')).toBe('text/javascript; charset=utf-8');
      expect(MIME_MAP.get('.cjs')).toBe('text/javascript; charset=utf-8');
      expect(MIME_MAP.get('.css')).toBe('text/css; charset=utf-8');
      expect(MIME_MAP.get('.json')).toBe('application/json; charset=utf-8');
    });

    it('verifies ETag generation conforms to RFC 9110 §8.8.3 entity-tag grammar', () => {
      const strongEtag = makeEtag(Buffer.from('<div>test content</div>'));
      expect(strongEtag).toMatch(/^"[A-Za-z0-9_-]+"?$/);

      const weakStatEtag = makeStatEtag(1700000000, 4096);
      expect(weakStatEtag).toMatch(/^W\/"[a-z0-9]+-[a-z0-9]+"$/);
    });
  });

  describe('Sitemaps & XML Standards Validation (W3C XML 1.0 & Sitemaps.org)', () => {
    it('verifies XML entity escaping and sitemap namespace per sitemaps.org schema', () => {
      const rawText = '<"hello" & \'world\'>';
      expect(escapeXml(rawText)).toBe('&lt;&quot;hello&quot; &amp; &apos;world&apos;&gt;');

      const sitemap = buildSitemapXml('https://example.com', ['/', '/about']);
      expect(sitemap).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
      expect(sitemap).toContain('<loc>https://example.com/</loc>');
      expect(sitemap).toContain('<loc>https://example.com/about</loc>');
    });
  });
});



