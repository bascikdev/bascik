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
      "<h3>Picks</h3>• <strong>One</strong> and <code>two</code><div></div><pre><code>let x = 1 &lt; 2;</code></pre>done",
    );
  });

  it("keeps at most one blank line between paragraphs", () => {
    expect(renderText("one\n\n\n\ntwo\nthree", catalog)).toBe(
      "one\n\ntwo\nthree",
    );
  });

  it("shows an unfinished tag as text when the stream ends", () => {
    expect(renderText(`before <book-card title="x`, catalog)).toBe(
      `before &lt;book-card title=&quot;x`,
    );
  });

  it("leaves unclosed bold and code markers as written", () => {
    expect(renderText("2 ** 3 and a ` tick\nnext", catalog)).toBe(
      "2 ** 3 and a ` tick\nnext",
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

  it("gives up on an element that never closes", () => {
    const renderer = createRenderer(catalog);
    renderer.push(`<card-grid>`);
    const html = renderer.push("x".repeat(40_000));
    expect(html.startsWith("&lt;card-grid&gt;")).toBe(true);
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
