/**
 * Fixtures for component-expansion-core.test.ts (prompt 157).
 *
 * They live apart from the test so the golden next to this file could be
 * generated from the pre-extraction `recursivelyTranspile` on exactly these
 * inputs: the test then compares the extracted loop with that recorded output
 * instead of with itself. Changing a fixture invalidates the golden, which
 * must then be regenerated from a known-good build, never from the code under
 * test.
 */
import type { ComponentList } from "../types.ts";

export const PAGE_PATH = "src/pages/catalog.html";

// Nested x3 (outer > mid > inner), named + default slots, a forwarded prop and
// a forwarded default slot, attr-bound props, scoped ids with a label/for pair
// and a script that references an id, a per-instance CSS component, and a
// component whose attr bindings target id-reference attributes.
export const componentList = (): ComponentList => ({
  "outer-box": {
    fileName: "src/components/outer-box.html",
    fileContent:
      `<section class="outer" id="root"><h2 class="t" data-bascik-prop-title></h2>` +
      `<mid-box data-bascik-prop-label="from outer" data-bascik-attr-data-bascik-prop-sub="title">` +
      `<div data-bascik-slot>outer fallback</div><div data-bascik-slot="head">outer head</div></mid-box>` +
      `<a data-bascik-attr-href="link" class="cta">go</a><p class="tail" data-bascik-slot="foot">no foot</p></section>`,
    cssFileContent: `.outer{color:red} .t{font-weight:bold} #root{margin:0}`,
  },
  "mid-box": {
    fileName: "src/components/mid-box.html",
    fileContent:
      `<div class="mid" id="m"><span data-bascik-prop-label></span><em data-bascik-prop-sub></em>` +
      `<inner-box><div data-bascik-slot></div></inner-box><b data-bascik-slot="head">mid head</b></div>`,
    cssFileContent: `.mid{a:b} #m{c:d}`,
  },
  "inner-box": {
    fileName: "src/components/inner-box.html",
    fileContent:
      `<article class="inner"><div data-bascik-slot>inner fallback</div>` +
      `<script>document.getElementById("m"); console.log("<inner-box>");</script></article>`,
    cssFileContent: `.inner{e:f}`,
  },
  "v-card": {
    fileName: "src/components/v-card.html",
    fileContent:
      `<div class="card" data-bascik-attr-title="t" data-bascik-attr-data-x="dx">` +
      `<a data-bascik-attr-href="link" class="lnk">go</a><img data-bascik-attr-src="img" data-bascik-attr-alt="alt">` +
      `<label for="x">L</label><input id="x" name="x"><span data-bascik-prop-t>Untitled</span></div>`,
    cssFileContent: `.card{color:red} .lnk{color:blue}`,
  },
  "glow-card": {
    fileName: "src/components/glow-card.html",
    fileContent: `<svg><filter id="glow"></filter></svg><div class="box"><style>.box { filter: url(#glow) }</style></div>`,
    cssFileContent: ".box { clip-path: url(#glow) }",
  },
  // One prop (`p`) bound to two targets, only one of which (`for`) holds an
  // id reference; `form` and `aria-describedby` are bare-id targets; `href`
  // takes a fragment; `title` is plain text that happens to equal an id.
  "ref-card": {
    fileName: "src/components/ref-card.html",
    fileContent:
      `<form id="f"><label data-bascik-attr-for="p" data-bascik-attr-title="p">L</label>` +
      `<input id="p" name="p" data-bascik-attr-form="fid" data-bascik-attr-aria-describedby="hint">` +
      `<p id="hint">h</p><a data-bascik-attr-href="link">go</a></form>`,
  },
});

export const PAGE = [
  // Entity-escaped props, inherited attributes, named + default slot content.
  `<outer-box data-bascik-prop-title="T &amp; &lt;b&gt; &quot;q&quot;" data-bascik-prop-link="/x?a=1&amp;b=2" class="user" aria-label="L">Hello <i>slot</i><div data-bascik-slot="foot">F</div></outer-box>`,
  `<outer-box data-bascik-prop-title="2nd">second</outer-box>`,
  // A nested usage inside slot content.
  `<mid-box data-bascik-prop-label="m">plain <inner-box>nested usage</inner-box></mid-box>`,
  // Attr-bound props, including a fragment href that scoping rewrites.
  `<v-card data-bascik-prop-link="#x" data-bascik-prop-t="T" data-bascik-prop-dx="1" data-bascik-prop-img="/a.png" data-bascik-prop-alt="pic"></v-card>`,
  `<glow-card></glow-card><glow-card></glow-card>`,
  // Masking traps: comment, textarea, script text, JSON-LD, escaped text in <pre><code>.
  `<!-- <outer-box> in a comment --><textarea><outer-box></outer-box></textarea><script>var s = "<v-card/>";</script><script type="application/ld+json">{"t":"<mid-box>"}</script><pre><code>&lt;outer-box&gt;</code></pre>`,
  // Uppercase, self-closing and unclosed usages.
  `<MID-BOX>upper</MID-BOX><inner-box /><inner-box>`,
].join("\n");

/** Attr bindings onto id-reference targets, two instances to number sourceURLs. */
export const ID_REFS_PAGE =
  `<ref-card data-bascik-prop-p="p" data-bascik-prop-fid="f" data-bascik-prop-hint="hint" data-bascik-prop-link="#hint"></ref-card>` +
  `<ref-card data-bascik-prop-p="p" data-bascik-prop-fid="f" data-bascik-prop-hint="hint" data-bascik-prop-link="/docs#hint"></ref-card>`;

/** The golden's shape: one entry per fixture page, per identifier mode. */
export interface GoldenEntry {
  html: string;
  /** `[name, cssFileContent, requiresPerInstanceCss, JSON scopedIdNames]` per used component. */
  instances: Array<
    [string, string | undefined, boolean | undefined, string | undefined]
  >;
}
export type Golden = Record<
  "identifiers:true" | "identifiers:false",
  Record<"page" | "noPath" | "idRefs", GoldenEntry>
>;
