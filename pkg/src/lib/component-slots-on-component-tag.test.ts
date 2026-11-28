/**
 * `data-bascik-slot="name"` written on a component tag.
 *
 * Between another component's tags, the tagged component is that slot's
 * content: it renders and its output lands in the slot, self-closing and
 * paired alike. It used to fail silently: the self-closing form rendered in
 * the default slot, and the paired form was read as a wrapper and removed,
 * so the component never rendered.
 */
import { describe, expect, it } from "vitest";
import {
  expandComponents,
  stripSourceFileComments,
} from "./component-expansion-core.ts";
import { BUILD_EXPANSION_LIMITS } from "./component-expansion.ts";
import {
  declaredNamedSlots,
  extractDefaultSlotContent,
  extractNamedSlotContent,
  removeUnclaimedSlotWrappers,
  repeatedNamedSlots,
  withoutSlotWrappers,
} from "./component-slots.ts";
import { deriveInstanceId } from "./names.ts";
import {
  clearScopingTemplates,
  scopeComponentInstance,
} from "./scoping-template.ts";
import type { ComponentList } from "./types.ts";

const PAGE = "src/pages/index.html";

const list: ComponentList = {
  "book-shelf": {
    fileName: "src/components/book-shelf.html",
    fileContent:
      '<form class="shelf"><div class="start"><span data-bascik-slot="start"></span></div><div class="books"><span data-bascik-slot></span></div><div class="below"><span data-bascik-slot="below"><small>NO-NOTES</small></span></div></form>',
  },
  "book-card": {
    fileName: "src/components/book-card.html",
    fileContent:
      '<label class="card" data-bascik-attr-data-rating="rating"><span data-bascik-slot>UNTITLED</span></label>',
  },
  // Declares a slot with the same name as one of book-shelf's.
  "book-panel": {
    fileName: "src/components/book-panel.html",
    fileContent:
      '<section class="panel"><h2 data-bascik-slot="start">PANEL-HEADING</h2><div data-bascik-slot></div></section>',
  },
  // A tagged component inside another component's usage, in a template.
  "book-app": {
    fileName: "src/components/book-app.html",
    fileContent:
      '<main><book-shelf><book-card data-bascik-slot="start" data-bascik-prop-rating="5" /></book-shelf></main>',
  },
  // The same, with this template's default slot forwarded into the tagged component.
  "book-forward": {
    fileName: "src/components/book-forward.html",
    fileContent:
      '<main><book-shelf><book-card data-bascik-slot="start"><i data-bascik-slot>APP-FALLBACK</i></book-card></book-shelf></main>',
  },
  // Tagged components written straight into a template, in no usage.
  "book-direct": {
    fileName: "src/components/book-direct.html",
    fileContent:
      '<main><book-card data-bascik-slot="side" /><book-card data-bascik-slot="other">Dune</book-card></main>',
  },
  // A tagged component inside a placeholder's fallback content.
  "book-fallback": {
    fileName: "src/components/book-fallback.html",
    fileContent:
      '<main><div data-bascik-slot="side"><book-card data-bascik-slot="deep">Emma</book-card></div></main>',
  },
  // Templates that render their own tag with a marker on it, in each form.
  "book-loop": {
    fileName: "src/components/book-loop.html",
    fileContent:
      '<div class="loop"><book-loop data-bascik-slot="s"></book-loop></div>',
  },
  "book-loop-short": {
    fileName: "src/components/book-loop-short.html",
    fileContent:
      '<div class="loop"><book-loop-short data-bascik-slot="s" /></div>',
  },
};

/** The component names the direct parser cases pass. */
const names = new Set(["book-card", "book-shelf"]);

const run = (html: string) => {
  const warnings: string[] = [];
  const instanceState = {
    ordinalMap: new Map<string, number>(),
    issuedIds: new Set<string>(),
  };
  clearScopingTemplates();
  const result = expandComponents(
    html,
    list,
    {
      scope: (component, instanceId) =>
        scopeComponentInstance(component, instanceId),
      mintId: (componentName, ordinal) =>
        deriveInstanceId(PAGE, componentName, ordinal, instanceState.issuedIds),
      injectAttrProps: "before-scope",
      numberSourceUrls: true,
      inheritAttributes: true,
      instanceState,
      limits: BUILD_EXPANSION_LIMITS,
      onError: (error) => {
        throw error;
      },
      warn: (message) => warnings.push(message),
    },
    [],
    PAGE,
  );
  return {
    html: stripSourceFileComments(result.transpiledHtmlBody),
    used: result.usedComponents.map((component) => component.name),
    warnings,
  };
};

/** The shelf's output with each region's content given. */
const shelf = (
  start: string,
  books: string,
  below = "<small>NO-NOTES</small>",
) =>
  `<form class="shelf"><div class="start">${start}</div><div class="books">${books}</div><div class="below">${below}</div></form>`;

describe("a component tag that carries data-bascik-slot fills that slot of the component around it", () => {
  it("self-closing: the component renders in the named slot, with its props, and not in the default slot", () => {
    const { html, used, warnings } = run(
      '<book-shelf><book-card data-bascik-slot="start" data-bascik-prop-rating="3" /></book-shelf>',
    );
    expect(html).toBe(
      shelf('<label class="card" data-rating="3">UNTITLED</label>', ""),
    );
    expect(used).toContain("book-card");
    expect(warnings).toEqual([]);
  });

  it("paired and empty: the component renders in the named slot instead of being removed", () => {
    const { html, used, warnings } = run(
      '<book-shelf><book-card data-bascik-slot="start"></book-card></book-shelf>',
    );
    expect(html).toBe(shelf('<label class="card">UNTITLED</label>', ""));
    expect(used).toContain("book-card");
    expect(warnings).toEqual([]);
  });

  it("paired with children: the children stay the component's own slot content", () => {
    const { html, warnings } = run(
      '<book-shelf><book-card data-bascik-slot="start" data-bascik-prop-rating="4"><b>Dune</b></book-card></book-shelf>',
    );
    expect(html).toBe(
      shelf('<label class="card" data-rating="4"><b>Dune</b></label>', ""),
    );
    expect(warnings).toEqual([]);
  });

  it("renders the same as the wrapper form, for both forms", () => {
    const wrapped = run(
      '<book-shelf><span data-bascik-slot="below"><book-card data-bascik-prop-rating="2">Emma</book-card></span><p>body</p></book-shelf>',
    ).html;
    expect(
      run(
        '<book-shelf><book-card data-bascik-slot="below" data-bascik-prop-rating="2">Emma</book-card><p>body</p></book-shelf>',
      ).html,
    ).toBe(wrapped);
    expect(wrapped).toBe(
      shelf(
        "",
        "<p>body</p>",
        '<label class="card" data-rating="2">Emma</label>',
      ),
    );
    const wrappedEmpty = run(
      '<book-shelf><span data-bascik-slot="below"><book-card /></span></book-shelf>',
    ).html;
    expect(
      run('<book-shelf><book-card data-bascik-slot="below" /></book-shelf>')
        .html,
    ).toBe(wrappedEmpty);
  });

  it("accepts the tag as Prettier writes it, and any quote style, letter case, or attribute order", () => {
    const expected = shelf(
      '<label class="card" data-rating="3">UNTITLED</label>',
      "",
    );
    for (const usage of [
      '<book-card\n    data-bascik-slot="start"\n    data-bascik-prop-rating="3"\n  />',
      '<book-card\n    data-bascik-prop-rating="3"\n    data-bascik-slot="start"\n  ></book-card>',
      "<book-card data-bascik-slot='start' data-bascik-prop-rating=\"3\"/>",
      '<book-card data-bascik-slot=start data-bascik-prop-rating="3" />',
      '<BOOK-CARD data-bascik-slot="Start" data-bascik-prop-rating="3"></BOOK-CARD>',
    ]) {
      const { html, warnings } = run(`<book-shelf>\n  ${usage}\n</book-shelf>`);
      expect(html, usage).toBe(expected);
      expect(warnings, usage).toEqual([]);
    }
  });

  it("leaves every other attribute on the tag: plain ones reach the component's root, and the marker never reaches the page", () => {
    const { html } = run(
      '<book-shelf><book-card id="pick" data-bascik-slot="start" title="a > b" data-kind="x" /></book-shelf>',
    );
    expect(html).toContain(
      '<div class="start"><label class="card" id="pick" title="a > b" data-kind="x">UNTITLED</label></div>',
    );
    expect(html).not.toContain("data-bascik-slot");
  });

  it("keeps regex replacement tokens in the children as written", () => {
    const { html } = run(
      '<book-shelf><book-card data-bascik-slot="start">$& $1 $` $$</book-card></book-shelf>',
    );
    expect(html).toContain('<label class="card">$& $1 $` $$</label>');
  });

  it("mixes with wrappers and default content; untagged components still go to the default slot", () => {
    const { html, warnings } = run(
      '<book-shelf><book-card>Default</book-card><book-card data-bascik-slot="start">Start</book-card><i data-bascik-slot="below">note</i><p>tail</p></book-shelf>',
    );
    expect(html).toBe(
      shelf(
        '<label class="card">Start</label>',
        '<label class="card">Default</label><p>tail</p>',
        "note",
      ),
    );
    expect(warnings).toEqual([]);
  });

  it("a valueless marker on a component tag names no slot: the component stays in the default slot", () => {
    for (const usage of [
      "<book-card data-bascik-slot />",
      "<book-card data-bascik-slot>Dune</book-card>",
    ]) {
      const { html } = run(`<book-shelf>${usage}</book-shelf>`);
      expect(html, usage).toContain('<div class="start"></div>');
      expect(html, usage).toMatch(
        /<div class="books"><label class="card">(?:UNTITLED|Dune)<\/label><\/div>/,
      );
      expect(html, usage).not.toContain("data-bascik-slot");
    }
  });

  it("a slot name the outer template does not declare is dropped with the usual warning, in both forms", () => {
    for (const usage of [
      '<book-card data-bascik-slot="shelf-top" />',
      '<book-card data-bascik-slot="shelf-top">Dune</book-card>',
    ]) {
      const { html, used, warnings } = run(`<book-shelf>${usage}</book-shelf>`);
      expect(html, usage).toBe(shelf("", ""));
      expect(used, usage).not.toContain("book-card");
      expect(warnings, usage).toHaveLength(1);
      expect(warnings[0]).toContain("<book-shelf>");
      expect(warnings[0]).toContain('slot "shelf-top"');
      expect(warnings[0]).toContain(PAGE);
      expect(warnings[0]).toContain("dropped");
    }
  });

  it("with no component around it, the marker does nothing and the component renders in place", () => {
    for (const usage of [
      '<book-card data-bascik-slot="start" />',
      '<book-card data-bascik-slot="start">Dune</book-card>',
    ]) {
      const { html } = run(`<div>${usage}</div>`);
      expect(html, usage).toMatch(
        /^<div><label class="card">(?:UNTITLED|Dune)<\/label><\/div>$/,
      );
    }
  });
});

describe("which component a marker on a component tag belongs to", () => {
  it("names a slot of the component around the tag, not of the tagged component itself", () => {
    // book-panel declares its own "start". The marker on its tag still means
    // book-shelf's "start"; the wrapper between its tags means its own.
    const { html, warnings } = run(
      '<book-shelf><book-panel data-bascik-slot="start"><b data-bascik-slot="start">MINE</b>body</book-panel></book-shelf>',
    );
    expect(html).toBe(shelf('<section class="panel">MINEbody</section>', ""));
    expect(warnings).toEqual([]);
  });

  it("leaves the tagged component's own slot at its fallback when nothing fills it", () => {
    const { html } = run(
      '<book-shelf><book-panel data-bascik-slot="start" /></book-shelf>',
    );
    expect(html).toBe(
      shelf('<section class="panel">PANEL-HEADING</section>', ""),
    );
  });

  it("works between a component's tags inside another component's template", () => {
    const { html, warnings } = run("<book-app />");
    expect(html).toBe(
      `<main>${shelf('<label class="card" data-rating="5">UNTITLED</label>', "")}</main>`,
    );
    expect(warnings).toEqual([]);
  });

  it("forwards the outer default slot through a tagged component, with the marker's content as fallback", () => {
    expect(run("<book-forward><em>Dune</em></book-forward>").html).toBe(
      `<main>${shelf('<label class="card"><em>Dune</em></label>', "")}</main>`,
    );
    expect(run("<book-forward />").html).toBe(
      `<main>${shelf('<label class="card">APP-FALLBACK</label>', "")}</main>`,
    );
  });

  it("is claimed by the nearest component: a tag inside a nested usage fills the nested component", () => {
    const { html, warnings } = run(
      '<book-panel><book-shelf><book-card data-bascik-slot="start">Emma</book-card></book-shelf></book-panel>',
    );
    expect(html).toBe(
      `<section class="panel">PANEL-HEADING${shelf('<label class="card">Emma</label>', "")}</section>`,
    );
    expect(warnings).toEqual([]);
  });

  it("inside a wrapper that already names a slot, the wrapper wins: the component renders there and only its marker is dropped", () => {
    for (const usage of [
      '<book-card data-bascik-slot="below" />',
      '<book-card data-bascik-slot="below"></book-card>',
    ]) {
      const { html, used, warnings } = run(
        `<book-shelf><div data-bascik-slot="start">${usage}</div></book-shelf>`,
      );
      expect(html, usage).toBe(
        shelf('<label class="card">UNTITLED</label>', ""),
      );
      expect(used, usage).toContain("book-card");
      expect(warnings, usage).toEqual([]);
    }
  });

  it("nested in a plain element, it is still taken out to its slot, as a wrapper is", () => {
    const { html } = run(
      '<book-shelf><section><book-card data-bascik-slot="start" /></section></book-shelf>',
    );
    expect(html).toBe(
      shelf('<label class="card">UNTITLED</label>', "<section></section>"),
    );
  });
});

describe("a tagged component written straight into a template declares no slot", () => {
  it("renders where it is written, self-closing and paired, and the marker never reaches the page", () => {
    const { html, warnings } = run("<book-direct />");
    expect(html).toBe(
      '<main><label class="card">UNTITLED</label><label class="card">Dune</label></main>',
    );
    expect(warnings).toEqual([]);
  });

  it("content passed for that name is dropped with a warning, for both forms", () => {
    const { html, warnings } = run(
      '<book-direct><b data-bascik-slot="side">S</b><b data-bascik-slot="other">O</b></book-direct>',
    );
    expect(html).toBe(
      '<main><label class="card">UNTITLED</label><label class="card">Dune</label></main>',
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('slot "side"');
    expect(warnings[1]).toContain('slot "other"');
  });

  it("is not listed as a declared slot", () => {
    const names = new Set(Object.keys(list));
    expect(declaredNamedSlots(list["book-direct"].fileContent!, names)).toEqual(
      [],
    );
    expect(declaredNamedSlots(list["book-shelf"].fileContent!, names)).toEqual([
      "start",
      "below",
    ]);
  });

  it("inside a placeholder's fallback it renders as fallback, with only its marker dropped", () => {
    expect(run("<book-fallback />").html).toBe(
      '<main><label class="card">Emma</label></main>',
    );
    expect(
      run('<book-fallback><b data-bascik-slot="side">S</b></book-fallback>')
        .html,
    ).toBe("<main>S</main>");
  });
});

describe("a slot name filled more than once", () => {
  const card = (title: string) => `<label class="card">${title}</label>`;

  it("two tagged components: the last one renders, and the build says the first was dropped", () => {
    for (const usage of [
      '<book-card data-bascik-slot="start">Dune</book-card><book-card data-bascik-slot="start">Emma</book-card>',
      '<book-card data-bascik-slot="start" />\n  <book-card\n    data-bascik-slot="start"\n  >Emma</book-card\n  >',
      // Names match whatever their letter case, as the slot fill matches them.
      '<book-card data-bascik-slot="Start">Dune</book-card><book-card data-bascik-slot="start">Emma</book-card>',
    ]) {
      const { html, warnings } = run(`<book-shelf>${usage}</book-shelf>`);
      expect(html, usage).toBe(shelf(card("Emma"), ""));
      expect(warnings, usage).toHaveLength(1);
      expect(warnings[0]).toContain("<book-shelf>");
      expect(warnings[0]).toContain("src/components/book-shelf.html");
      expect(warnings[0]).toMatch(/slot "start" is filled more than once/i);
      expect(warnings[0]).toContain(PAGE);
      expect(warnings[0]).toContain("dropped");
      expect(warnings[0]).toMatch(/one element with data-bascik-slot="start"/i);
    }
  });

  it("a tagged component and a wrapper, or two wrappers, warn the same way", () => {
    for (const [usage, start] of [
      [
        '<book-card data-bascik-slot="start">Dune</book-card><p data-bascik-slot="start">Emma</p>',
        "Emma",
      ],
      [
        '<p data-bascik-slot="start">Emma</p><book-card data-bascik-slot="start">Dune</book-card>',
        card("Dune"),
      ],
      [
        '<p data-bascik-slot="start">Dune</p><p data-bascik-slot="start">Emma</p>',
        "Emma",
      ],
    ]) {
      const { html, warnings } = run(`<book-shelf>${usage}</book-shelf>`);
      expect(html, usage).toBe(shelf(start, ""));
      expect(warnings, usage).toHaveLength(1);
      expect(warnings[0], usage).toContain(
        'slot "start" is filled more than once',
      );
    }
  });

  it("the fix it names, one wrapper around both, renders both with no warning", () => {
    const { html, warnings } = run(
      '<book-shelf><span data-bascik-slot="start"><book-card>Dune</book-card><book-card data-bascik-slot="start">Emma</book-card></span></book-shelf>',
    );
    expect(html).toBe(shelf(card("Dune") + card("Emma"), ""));
    expect(warnings).toEqual([]);
  });

  it("different names, and a name the nested component fills, do not warn", () => {
    const { html, warnings } = run(
      '<book-shelf><book-card data-bascik-slot="start">Dune</book-card><book-panel data-bascik-slot="below"><b data-bascik-slot="start">Emma</b></book-panel></book-shelf>',
    );
    expect(html).toBe(
      shelf(card("Dune"), "", '<section class="panel">Emma</section>'),
    );
    expect(warnings).toEqual([]);
  });

  it("a repeated name the template does not declare gets the not-declared warning alone", () => {
    const { warnings } = run(
      '<book-shelf><book-card data-bascik-slot="shelf-top" /><book-card data-bascik-slot="shelf-top" /></book-shelf>',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not declared");
  });

  it("repeatedNamedSlots names each repeated slot once, as first written", () => {
    expect(
      repeatedNamedSlots(
        '<book-card data-bascik-slot="A" /><i data-bascik-slot="b">x</i><p data-bascik-slot="a">y</p><book-card data-bascik-slot="a"></book-card>',
        names,
      ),
    ).toEqual(["A"]);
    expect(repeatedNamedSlots('<i data-bascik-slot="b">x</i>', names)).toEqual(
      [],
    );
    expect(repeatedNamedSlots(undefined, names)).toEqual([]);
    // A fill inside a nested usage is the nested component's.
    expect(
      repeatedNamedSlots(
        '<i data-bascik-slot="b">x</i><book-card><i data-bascik-slot="b">y</i></book-card>',
        names,
      ),
    ).toEqual([]);
  });
});

describe("a template that renders its own tag with a marker on it", () => {
  it("is reported as a component cycle at once, paired and self-closing alike", () => {
    for (const name of ["book-loop", "book-loop-short"]) {
      const started = performance.now();
      expect(() => run(`<${name}></${name}>`), name).toThrow(
        new RegExp(`component cycle detected: <${name}> -> <${name}>`),
      );
      // The paired form used to run to the 10000-substitution limit (seconds).
      expect(performance.now() - started, name).toBeLessThan(1000);
    }
  });

  it("withoutSlotWrappers keeps a tagged component and still blanks real wrappers", () => {
    expect(
      withoutSlotWrappers(
        '<div><book-card data-bascik-slot="s">t</book-card><book-card data-bascik-slot="s" /><i data-bascik-slot="f"><book-shelf /></i></div>',
        names,
      ),
    ).toBe(
      '<div><book-card data-bascik-slot="s">t</book-card><book-card data-bascik-slot="s" /> </div>',
    );
    // A wrapper between a nested usage's tags is blanked, as before.
    expect(
      withoutSlotWrappers(
        '<book-shelf><i data-bascik-slot="start"><book-card /></i></book-shelf>',
        names,
      ),
    ).toBe("<book-shelf> </book-shelf>");
    // With no names given, every marked tag is a wrapper.
    expect(
      withoutSlotWrappers('<book-card data-bascik-slot="s">t</book-card>'),
    ).toBe(" ");
  });
});

describe("the slot parser on a tagged component", () => {
  it("gives the whole component, without the marker, as the slot's content", () => {
    expect(
      extractNamedSlotContent(
        '<p>a</p><book-card data-bascik-slot="start" data-bascik-prop-rating="3" /><p>b</p>',
        names,
      ),
    ).toEqual({ start: '<book-card data-bascik-prop-rating="3" />' });
    expect(
      extractNamedSlotContent(
        '<book-card class="x" data-bascik-slot="start"><i data-bascik-slot="inner">k</i></book-card>',
        names,
      ),
    ).toEqual({
      start:
        '<book-card class="x"><i data-bascik-slot="inner">k</i></book-card>',
    });
  });

  it("takes it out of the default slot's content", () => {
    expect(
      extractDefaultSlotContent(
        '<p>a</p><book-card data-bascik-slot="start" /><p>b</p><book-card data-bascik-slot="below">x</book-card>',
        names,
      ),
    ).toBe("<p>a</p><p>b</p>");
  });

  it("an unclosed component tag is the open tag alone", () => {
    expect(
      extractNamedSlotContent(
        '<book-card data-bascik-slot="start"><p>after</p>',
        names,
      ),
    ).toEqual({ start: "<book-card>" });
  });

  it("a tag that is not a registered component is still a wrapper", () => {
    expect(
      extractNamedSlotContent(
        '<other-thing data-bascik-slot="start"><b>k</b></other-thing>',
        names,
      ),
    ).toEqual({ start: "<b>k</b>" });
  });

  it("the marker text inside a quoted attribute value is not a marker", () => {
    const usage =
      '<book-card title=\'data-bascik-slot="start"\' data-bascik-prop-rating="3" />';
    expect(extractNamedSlotContent(usage, names)).toEqual({});
    expect(extractDefaultSlotContent(usage, names)).toBe(usage);
  });

  it("a tagged component in a nested usage is left for the nested component", () => {
    const usage =
      '<book-shelf><book-card data-bascik-slot="start" /></book-shelf>';
    expect(extractNamedSlotContent(usage, names)).toEqual({});
    expect(extractDefaultSlotContent(usage, names)).toBe(usage);
  });

  it("removeUnclaimedSlotWrappers drops only the marker of a tagged component inside a wrapper", () => {
    expect(
      removeUnclaimedSlotWrappers(
        '<div data-bascik-slot="a"><book-card data-bascik-slot="b" class="x">k</book-card><book-card data-bascik-slot="c" /></div>',
        names,
      ),
    ).toBe(
      '<div data-bascik-slot="a"><book-card class="x">k</book-card><book-card /></div>',
    );
  });

  it("removeUnclaimedSlotWrappers drops the marker inside a lone wrapper and keeps one outside it", () => {
    expect(
      removeUnclaimedSlotWrappers(
        '<book-card data-bascik-slot="a" /><div data-bascik-slot="w"><book-card data-bascik-slot="b" /></div><book-card data-bascik-slot="c">k</book-card>',
        names,
      ),
    ).toBe(
      '<book-card data-bascik-slot="a" /><div data-bascik-slot="w"><book-card /></div><book-card data-bascik-slot="c">k</book-card>',
    );
  });

  it("removeUnclaimedSlotWrappers keeps the marker of a tagged component a component can claim", () => {
    for (const template of [
      '<book-card data-bascik-slot="a" /><i data-bascik-slot="b">x</i>',
      '<div data-bascik-slot="a"><book-shelf><book-card data-bascik-slot="start" /></book-shelf></div>',
      '<book-card data-bascik-slot="a"><i data-bascik-slot="b">x</i></book-card><i data-bascik-slot="c">y</i>',
    ])
      expect(removeUnclaimedSlotWrappers(template, names), template).toBe(
        template,
      );
  });
});
