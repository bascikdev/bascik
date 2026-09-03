/**
 * W3C CSS Media Queries Test Suite Conformance
 *
 * Grounded in:
 * - W3C CSS Media Queries 20120229 Release Candidate
 *   (https://www.w3.org/Style/CSS/Test/MediaQueries/20120229/test_media_queries.html)
 * - W3C CSS Snapshot 2026 §2.1 [CSS3-MEDIAQUERIES] & §2.2 [MEDIAQUERIES-4]
 * - WPT Media Queries Test Suite (https://wpt.live/css/mediaqueries/)
 *
 * Verifies that Bascik's CSS scoping and minification engines accurately parse,
 * scope, preserve, and transform CSS rules contained within media query blocks.
 */
import { describe, it, expect } from 'vitest';
import {
  convertCssElementSelectorsToClasses,
  scopeCssCustomProperties,
  scopeInlineStyleTags,
  shieldCssStrings,
} from './styles.ts';
import { minifyCss } from './css-minifier.ts';

describe('W3C Media Queries 20120229 & Media Queries 4 Conformance', () => {
  const componentName = 'media-box';

  describe('1. Media Types & Basic Query Expressions', () => {
    it('scopes element selectors within standard media types (all, screen, print, speech)', () => {
      const inputCss = `
        @media screen {
          p { color: red; }
          span { font-weight: bold; }
        }
        @media print {
          p { color: black; }
          a { text-decoration: underline; }
        }
        @media speech {
          p { voice-family: female; }
        }
        @media all {
          div { margin: 0; }
        }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain('@media screen');
      expect(scoped).toContain(`.bascik__${componentName}__el__p { color: red; }`);
      expect(scoped).toContain(`.bascik__${componentName}__el__span { font-weight: bold; }`);
      expect(scoped).toContain('@media print');
      expect(scoped).toContain(`.bascik__${componentName}__el__p { color: black; }`);
      expect(scoped).toContain(`.bascik__${componentName}__el__a { text-decoration: underline; }`);
      expect(scoped).toContain('@media speech');
      expect(scoped).toContain(`.bascik__${componentName}__el__p { voice-family: female; }`);
      expect(scoped).toContain('@media all');
      expect(scoped).toContain(`.bascik__${componentName}__el__div { margin: 0; }`);
    });

    it('handles logical operators: and, not, only, and comma-separated query lists', () => {
      const inputCss = `
        @media only screen and (min-width: 480px) and (max-width: 768px) {
          h1 { font-size: 1.5rem; }
        }
        @media not print and (monochrome) {
          p { color: navy; }
        }
        @media screen and (orientation: landscape), print and (color) {
          article { display: flex; }
        }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain('@media only screen and (min-width: 480px) and (max-width: 768px)');
      expect(scoped).toContain(`.bascik__${componentName}__el__h1`);
      expect(scoped).toContain('@media not print and (monochrome)');
      expect(scoped).toContain(`.bascik__${componentName}__el__p`);
      expect(scoped).toContain('@media screen and (orientation: landscape), print and (color)');
      expect(scoped).toContain(`.bascik__${componentName}__el__article`);
    });
  });

  describe('2. Media Features from W3C 20120229 Vector Catalog', () => {
    it('accurately preserves width, height, aspect-ratio, orientation, and resolution expressions', () => {
      const inputCss = `
        @media (width: 800px) { p { margin: 10px; } }
        @media (min-width: 320px) and (max-width: 1024px) { section { padding: 8px; } }
        @media (height: 600px) { p { height: 100%; } }
        @media (min-height: 400px) { div { min-height: 400px; } }
        @media (device-width: 1920px) { body { font-size: 16px; } }
        @media (device-height: 1080px) { main { max-width: 1200px; } }
        @media (orientation: landscape) { nav { flex-direction: row; } }
        @media (orientation: portrait) { nav { flex-direction: column; } }
        @media (aspect-ratio: 16/9) { video { width: 100%; } }
        @media (min-aspect-ratio: 4/3) { img { object-fit: cover; } }
        @media (color) { .badge { color: #fff; } }
        @media (min-color: 8) { .photo { filter: none; } }
        @media (color-index: 256) { .icon { image-rendering: pixelated; } }
        @media (monochrome) { * { color: #000; } }
        @media (resolution: 2dppx), (min-resolution: 192dpi), (min-resolution: 75dpcm) {
          .retina { background-image: url('retina.png'); }
        }
        @media (scan: progressive) { header { backdrop-filter: blur(5px); } }
        @media (grid: 0) { footer { display: block; } }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain('@media (width: 800px)');
      expect(scoped).toContain(`.bascik__${componentName}__el__p`);
      expect(scoped).toContain('@media (min-width: 320px) and (max-width: 1024px)');
      expect(scoped).toContain(`.bascik__${componentName}__el__section`);
      expect(scoped).toContain('@media (orientation: landscape)');
      expect(scoped).toContain(`.bascik__${componentName}__el__nav`);
      expect(scoped).toContain('@media (aspect-ratio: 16/9)');
      expect(scoped).toContain(`.bascik__${componentName}__el__video`);
      expect(scoped).toContain('@media (resolution: 2dppx), (min-resolution: 192dpi), (min-resolution: 75dpcm)');
      expect(scoped).toContain('.photo { filter: none; }');
    });
  });

  describe('3. Modern Media Queries Level 4 Features', () => {
    it('handles range syntax expressions (@media (width <= 800px), @media (400px < width < 1000px))', () => {
      const inputCss = `
        @media (width <= 800px) {
          p { font-size: 14px; }
        }
        @media (400px < width <= 1000px) {
          div { padding: 12px; }
        }
        @media (height >= 600px) {
          section { min-height: 50vh; }
        }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);

      expect(scoped).toContain('@media (width <= 800px)');
      expect(scoped).toContain(`.bascik__${componentName}__el__p`);
      expect(scoped).toContain('@media (400px < width <= 1000px)');
      expect(scoped).toContain(`.bascik__${componentName}__el__div`);
      expect(scoped).toContain('@media (height >= 600px)');
      expect(scoped).toContain(`.bascik__${componentName}__el__section`);
    });

    it('handles user-preference media features (prefers-color-scheme, prefers-reduced-motion, forced-colors)', () => {
      const inputCss = `
        @media (prefers-color-scheme: dark) {
          .container {
            --bg-color: #121212;
            --text-color: #e0e0e0;
            color: var(--text-color);
          }
          p { color: var(--text-color); }
        }
        @media (prefers-reduced-motion: reduce) {
          .animated { animation-duration: 0.01ms !important; }
        }
        @media (prefers-contrast: more) {
          button { border: 2px solid black; }
        }
        @media (forced-colors: active) {
          .card { border: 1px solid ButtonText; }
        }
      `;
      let css = inputCss;
      css = scopeCssCustomProperties(css, componentName);
      const { css: scoped } = convertCssElementSelectorsToClasses(css, componentName);

      expect(scoped).toContain('@media (prefers-color-scheme: dark)');
      expect(scoped).toContain(`--bascik__${componentName}__bg-color: #121212;`);
      expect(scoped).toContain(`--bascik__${componentName}__text-color: #e0e0e0;`);
      expect(scoped).toContain(`var(--bascik__${componentName}__text-color)`);
      expect(scoped).toContain(`.bascik__${componentName}__el__p`);
      expect(scoped).toContain('@media (prefers-reduced-motion: reduce)');
      expect(scoped).toContain('@media (forced-colors: active)');
    });
  });

  describe('4. Nested Scoping Invariants inside Media Queries', () => {
    it('scopes @keyframes, @layer, @container, and custom properties defined inside @media', () => {
      const inputHtml = `
        <style>
        @media (min-width: 600px) {
          @layer components {
            .card {
              container-name: panel;
              --card-pad: 20px;
              padding: var(--card-pad);
              animation: slideIn 0.3s ease;
            }
          }
          @keyframes slideIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @container panel (min-width: 400px) {
            h2 { font-size: 2rem; }
          }
        }
        </style>
      `;
      const { html: scopedHtml } = scopeInlineStyleTags(inputHtml, componentName);

      expect(scopedHtml).toContain('@media (min-width: 600px)');
      expect(scopedHtml).toContain(`@layer bascik__${componentName}__layer__components`);
      expect(scopedHtml).toContain(`--bascik__${componentName}__card-pad: 20px;`);
      expect(scopedHtml).toContain(`container-name: bascik__${componentName}__container__panel;`);
      expect(scopedHtml).toContain(`animation: bascik__${componentName}__keyframe__slideIn 0.3s ease;`);
      expect(scopedHtml).toContain(`@keyframes bascik__${componentName}__keyframe__slideIn`);
      expect(scopedHtml).toContain(`@container bascik__${componentName}__container__panel (min-width: 400px)`);
      expect(scopedHtml).toContain(`.bascik__${componentName}__el__h2`);
    });

    it('preserves CSS string literals and URLs inside @media rules', () => {
      const inputCss = `
        @media screen and (min-width: 768px) {
          .banner::before {
            content: "Screen >= 768px (Desktop Layout)";
            background: url("https://example.com/asset.png?q=width:800px");
          }
        }
      `;
      const { css: shielded, restore } = shieldCssStrings(inputCss);
      const { css: scoped } = convertCssElementSelectorsToClasses(shielded, componentName);
      const unshielded = restore(scoped);

      expect(unshielded).toContain('content: "Screen >= 768px (Desktop Layout)";');
      expect(unshielded).toContain('background: url("https://example.com/asset.png?q=width:800px");');
    });

    it('minifies media query CSS without syntax corruption', () => {
      const inputCss = `
        @media screen and (min-width: 600px) {
          .header {
            display: flex;
            justify-content: space-between;
          }
          p {
            margin: 0;
            color: #333333;
          }
        }
      `;
      const { css: scoped } = convertCssElementSelectorsToClasses(inputCss, componentName);
      const minified = minifyCss(scoped);

      expect(minified).toContain('@media screen and (min-width:600px){');
      expect(minified).toContain('.header{display:flex;justify-content:space-between;}');
      expect(minified).toContain(`.bascik__${componentName}__el__p{margin:0;color:#333333;}`);
    });
  });
});
