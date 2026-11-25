import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "./catalog.ts";
import { createRenderer, renderStream, renderText } from "./render.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "book-card.html",
      `<article><h3 data-bascik-prop-title></h3><p data-bascik-prop-author></p><span data-bascik-slot></span></article>`,
    )!,
    describeComponent(
      "card-grid.html",
      `<div><span data-bascik-slot></span></div>`,
    )!,
    describeComponent(
      "bar-row.html",
      `<li><meter data-bascik-attr-value="value" data-bascik-attr-max="max"></meter></li>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

const CARD = `<book-card title="Refactoring the Monolith" author="Grace Lin">Best seller</book-card>`;
const CARD_HTML = `<book-card data-bascik-prop-title="Refactoring the Monolith" data-bascik-prop-author="Grace Lin">Best seller</book-card>`;

/** Feed `text` in slices of `size` and collect every chunk the renderer gives back. */
function chunked(text: string, size: number): string[] {
  const renderer = createRenderer(catalog);
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) {
    const html = renderer.push(text.slice(at, at + size));
    if (html) chunks.push(html);
  }
  const rest = renderer.end();
  if (rest) chunks.push(rest);
  return chunks;
}

/** Every `<` that opens or closes a tag is matched inside the same chunk. */
function isWholeElements(html: string): boolean {
  const stack: string[] = [];
  for (const tag of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)[^>]*>/g)) {
    if (tag[1]) {
      if (stack.pop() !== tag[2]) return false;
    } else {
      stack.push(tag[2]!);
    }
  }
  return stack.length === 0 && !/<[^>]*$/.test(html);
}

describe("renderText", () => {
  it("maps a catalog tag's attributes to props", () => {
    expect(renderText(CARD, catalog)).toBe(CARD_HTML);
  });

  it("accepts single quotes, bare values, and self-closing tags", () => {
    expect(renderText(`<bar-row value='12' max=40 />`, catalog)).toBe(
      `<bar-row data-bascik-prop-value="12" data-bascik-prop-max="40"></bar-row>`,
    );
  });

  it("renders catalog tags nested in a slot", () => {
    expect(renderText(`<card-grid>\n${CARD}\n</card-grid>`, catalog)).toBe(
      `<card-grid>${CARD_HTML}</card-grid>`,
    );
  });

  it("drops attributes the component does not declare", () => {
    const html = renderText(
      `<book-card title="x" onclick="alert(1)" data-bascik-prop-author="y" style="color:red">hi</book-card>`,
      catalog,
    );
    expect(html).toBe(`<book-card data-bascik-prop-title="x">hi</book-card>`);
  });

  it("escapes prop values and slot text", () => {
    const html = renderText(
      `<book-card title='"><script>alert(1)</script>'><img src=x onerror=alert(2)></book-card>`,
      catalog,
    );
    expect(html).toBe(
      `<book-card data-bascik-prop-title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&lt;img src=x onerror=alert(2)&gt;</book-card>`,
    );
  });

  it("shows every tag outside the catalog as text", () => {
    const html = renderText(
      `<script>alert(1)</script> <admin-panel secret="1"> <a href="javascript:x">y</a> 1 < 2`,
      catalog,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<admin-panel");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("1 &lt; 2");
  });

  it("does not let a directive script through a slot", () => {
    const html = renderText(
      `<card-grid><script data-bascik-server>export default () => "x"</script></card-grid>`,
      catalog,
    );
    expect(html).not.toContain("<script");
  });

  it("ignores content given to a component with no slot", () => {
    expect(renderText(`<bar-row value="1">text</bar-row>`, catalog)).toBe(
      `<bar-row data-bascik-prop-value="1"></bar-row>`,
    );
  });

  it("renders headings, bullets, bold, code, and fences", () => {
    const html = renderText(
      "# Picks\n- **One** and `two`\n\n```\nlet x = 1 < 2;\n```\ndone",
      catalog,
    );
    expect(html).toBe(
      "<h3>Picks</h3><div></div>• <strong>One</strong> and <code>two</code><div></div><code data-line>let x = 1 &lt; 2;</code>done",
    );
  });

  it("streams a code fence one line at a time", () => {
    const renderer = createRenderer(catalog);
    expect(renderer.push("```ts\nconst a")).toBe("");
    expect(renderer.push(" = 1;\n\n  <book-card>")).toBe(
      "<code data-line>const a = 1;</code><code data-line><br></code>",
    );
    expect(renderer.push("\n```\nafter")).toBe(
      "<code data-line>  &lt;book-card&gt;</code>after",
    );
  });

  it("keeps at most one blank line between paragraphs", () => {
    expect(renderText("one\n\n\n\ntwo\nthree", catalog)).toBe(
      "one<br><br>two<br>three",
    );
  });

  it("shows an unfinished tag as text when the stream ends", () => {
    expect(renderText(`before <book-card title="x`, catalog)).toBe(
      `before &lt;book-card title=&quot;x`,
    );
  });

  it("leaves unclosed bold and code markers as written", () => {
    expect(renderText("2 ** 3 and a ` tick\nnext", catalog)).toBe(
      "2 ** 3 and a ` tick<br>next",
    );
  });
});

describe("createRenderer", () => {
  const reply = [
    "Here are **two** picks, with `code` too:",
    "",
    `<card-grid>`,
    CARD,
    `<book-card title="Practical Type Systems" author="Ada Okafor" />`,
    `</card-grid>`,
    "",
    "# After",
    "- a < b",
    "```",
    "<book-card>",
    "```",
    "The end.",
  ].join("\n");

  it("gives the same HTML however the stream is sliced", () => {
    const whole = renderText(reply, catalog);
    for (const size of [1, 2, 3, 5, 8, 13, 50, 1000]) {
      expect(chunked(reply, size).join(""), `slice size ${size}`).toBe(whole);
    }
  });

  it("only ever returns whole elements", () => {
    for (const size of [1, 2, 3, 7, 11]) {
      for (const chunk of chunked(reply, size)) {
        expect(isWholeElements(chunk), chunk).toBe(true);
      }
    }
  });

  it("streams text before a component is complete, and the component in one piece", () => {
    const chunks = chunked(`Hello there. ${CARD} Bye.`, 4);
    expect(chunks[0]).toBe("Hell");
    const withCard = chunks.filter((chunk) => chunk.includes("book-card"));
    expect(withCard).toHaveLength(1);
    expect(withCard[0]!.startsWith(CARD_HTML)).toBe(true);
  });

  it("does not hold back a `<` that cannot start a catalog tag", () => {
    const renderer = createRenderer(catalog);
    expect(renderer.push("a <")).toBe("a ");
    expect(renderer.push("3")).toBe("&lt;3");
    expect(renderer.push(" <boo")).toBe(" ");
    expect(renderer.push("m>")).toBe("&lt;boom&gt;");
  });

  it("closes an element where it stands when the stream ends inside it", () => {
    expect(
      renderText(`<card-grid>${CARD}<book-card title="B">half`, catalog),
    ).toBe(
      `<card-grid>${CARD_HTML}<book-card data-bascik-prop-title="B">half</book-card></card-grid>`,
    );
  });

  it("closes an element that buffers too much instead of holding it forever", () => {
    const renderer = createRenderer(catalog);
    expect(renderer.push(`<card-grid>`)).toBe("");
    let html = "";
    for (let sent = 0; sent < 300_000 && !html; sent += 10_000) {
      html = renderer.push("x".repeat(10_000));
    }
    expect(html.startsWith("<card-grid>xxx")).toBe(true);
    expect(html).toContain("</card-grid>");
  });

  it("leaves out components past the limit and says so", () => {
    const html = renderText(
      `<card-grid>${CARD.repeat(5)}</card-grid>after`,
      catalog,
      { maxComponents: 3 },
    );
    // The grid is a component too, counted before what it holds.
    expect(html.match(/<book-card/g)).toHaveLength(2);
    expect(html).toContain(
      "</card-grid>3 more items were left out to keep this reply a reasonable size.",
    );
    // The count is for the whole reply, not one element at a time: the
    // second grid is past the budget, and so is everything in it.
    const two = renderText(
      `<card-grid>${CARD}</card-grid><card-grid>${CARD.repeat(2)}</card-grid>`,
      catalog,
      { maxComponents: 2 },
    );
    expect(two.match(/<book-card/g)).toHaveLength(1);
    expect(two.match(/<card-grid>/g)).toHaveLength(1);
    expect(two).toContain("3 more items were left out");
  });

  it("counts top-level components against the limit too", () => {
    const html = renderText(`${CARD}\n`.repeat(1200) + "That is all.", catalog);
    expect(html.match(/<book-card/g)).toHaveLength(300);
    expect(html).toContain(
      "900 more items were left out to keep this reply a reasonable size.",
    );
    expect(html).toMatch(/That is all\.$/);
    // Self-closed tags, streamed in small slices, are held to the same budget.
    const renderer = createRenderer(catalog, { maxComponents: 5 });
    const tags = `<bar-row value="1" max="2" />\n`.repeat(40);
    let streamed = "";
    for (let at = 0; at < tags.length; at += 7) {
      streamed += renderer.push(tags.slice(at, at + 7));
    }
    streamed += renderer.end();
    expect(streamed.match(/<bar-row/g)).toHaveLength(5);
    expect(streamed).toContain("35 more items were left out");
  });

  it("shares one budget between renderers given the same budget", () => {
    const budget = { used: 0 };
    const first = renderText(
      CARD.repeat(3),
      catalog,
      { maxComponents: 4 },
      budget,
    );
    const second = renderText(
      CARD.repeat(3),
      catalog,
      { maxComponents: 4 },
      budget,
    );
    expect(first.match(/<book-card/g)).toHaveLength(3);
    expect(second.match(/<book-card/g)).toHaveLength(1);
    expect(second).toContain("2 more items were left out");
  });

  it("refuses nesting deeper than six levels", () => {
    const html = renderText("<card-grid>".repeat(8) + "x", catalog);
    expect(html.match(/<card-grid>/g)).toHaveLength(6);
    expect(html).toContain("&lt;card-grid&gt;&lt;card-grid&gt;x");
  });

  it("shows an opening tag that never ends as text", () => {
    const renderer = createRenderer(catalog);
    renderer.push(`<book-card title="`);
    const html = renderer.push("y".repeat(9000));
    expect(html.startsWith("&lt;book-card title=&quot;yyy")).toBe(true);
  });
});

describe("passed-through elements", () => {
  const options = { elements: ["table", "thead", "tbody", "tr", "th", "td"] };

  it("passes a table through bare, with its attributes dropped", () => {
    const html = renderText(
      `<table class="x" onclick="alert(1)"><tr><th scope=col>Title</th></tr><tr><td style="color:red">A **bold** < b</td></tr></table>`,
      catalog,
      options,
    );
    expect(html).toBe(
      "<table><tr><th>Title</th></tr><tr><td>A <strong>bold</strong> &lt; b</td></tr></table>",
    );
  });

  it("shows the same tags as text when they are not asked for", () => {
    expect(renderText("<table><tr><td>x</td></tr></table>", catalog)).toBe(
      "&lt;table&gt;&lt;tr&gt;&lt;td&gt;x&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;",
    );
  });

  it("refuses an element outside the safe list", () => {
    expect(() => createRenderer(catalog, { elements: ["script"] })).toThrow();
    expect(() => createRenderer(catalog, { elements: ["a"] })).toThrow();
  });
});

describe("renderStream", () => {
  it("yields rendered chunks from an async stream", async () => {
    async function* deltas() {
      yield "Hi ";
      yield `<book-card title="A"`;
      yield ` />`;
    }
    const chunks: string[] = [];
    for await (const chunk of renderStream(deltas(), catalog)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      "Hi ",
      `<book-card data-bascik-prop-title="A"></book-card>`,
    ]);
  });
});
