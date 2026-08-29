import { describe, it, expect } from 'vitest';
import * as elements from '@webref/elements';
import * as idl from '@webref/idl';
import * as webidl2 from 'webidl2';
import bcd from '@mdn/browser-compat-data';
import { NATIVE_HTML_ELEMENTS } from './components.js';
import { convertCssElementSelectorsToClasses, scopeLayerNames, scopeContainerNames } from './styles.js';
import { prefixElementAttribute, namespaceScriptTags } from './javascript.js';
import { INLINE_TAGS } from './html-minifier.js';

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
        fileContent: `<script type="module">import { x } from './x.js';</script>`,
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
  });
});



