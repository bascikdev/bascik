import { describe, expect, it } from "vitest";
import { mermaidFence, safeSvg, spaceArrows } from "./mermaid.ts";
import { createRenderer, renderText } from "./render.ts";

const FLOW = "flowchart TD\n  A[Start] --> B{Ready?}\n  B -->|Yes| C[Ship]";
const fences = { mermaid: mermaidFence() };
const draw = (text: string): string => renderText(text, new Map(), { fences });

/** The labels of the nodes a drawn diagram holds, in order. */
const nodes = (html: string): string[] =>
  [...html.matchAll(/class="node"[^>]*data-label="([^"]*)"/g)].map(
    (match) => match[1]!,
  );

describe("mermaidFence", () => {
  it("draws a mermaid fence as one inline SVG", () => {
    const html = draw(`Before\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\nAfter`);
    expect(html).toMatch(
      /^Before<div><\/div><figure class="diagram" data-testid="diagram"><svg [\s\S]*<\/svg><\/figure>After$/,
    );
    expect(nodes(html)).toEqual(["Start", "Ready?", "Ship"]);
    expect(html).not.toContain("flowchart TD");
  });

  it.each([
    ["sequenceDiagram", "sequenceDiagram\n  Reader->>Shop: Any picks?"],
    ["stateDiagram-v2", "stateDiagram-v2\n  [*] --> Reading"],
    ["classDiagram", "classDiagram\n  Book <|-- Novel"],
    ["erDiagram", "erDiagram\n  AUTHOR ||--o{ BOOK : writes"],
    ["xychart-beta", "xychart-beta\n  x-axis [a, b]\n  bar [1, 5]"],
  ])("draws a %s", (_, source) => {
    expect(fences.mermaid(source)).toMatch(/^<figure class="diagram"/);
  });

  it("leaves the font and the colors to the page", () => {
    const html = fences.mermaid(FLOW)!;
    expect(html).not.toMatch(
      /@import|fonts\.googleapis|https?:\/\/(?!www\.w3)/,
    );
    expect(html).not.toMatch(/<svg[^>]*\sstyle=/);
    expect(html).toContain("var(--fg)");
  });

  it("holds the fence back until it closes, whatever the slices", () => {
    const text = `\`\`\`mermaid\n${FLOW}\n\`\`\`\ndone`;
    const whole = draw(text);
    for (const size of [1, 2, 3, 7, 50]) {
      const renderer = createRenderer(new Map(), { fences });
      const chunks: string[] = [];
      for (let at = 0; at < text.length; at += size) {
        chunks.push(renderer.push(text.slice(at, at + size)));
      }
      chunks.push(renderer.end());
      // Nothing is sent before the diagram, and it is sent in one piece.
      const sent = chunks.filter(Boolean);
      expect(sent[0]).toMatch(/^<figure[\s\S]*<\/figure>/);
      expect(sent.join("")).toBe(whole);
    }
  });

  it("shows what it cannot draw as code", () => {
    expect(draw("```mermaid\ngantt\n  title Plan\n```")).toBe(
      "<code data-line>gantt</code><code data-line>  title Plan</code>",
    );
    expect(draw("```mermaid\n<script>alert(1)</script>\n```")).toBe(
      "<code data-line>&lt;script&gt;alert(1)&lt;/script&gt;</code>",
    );
    expect(fences.mermaid("")).toBeNull();
    expect(mermaidFence({ maxLength: 10 })(FLOW)).toBeNull();
  });

  it("draws a fence the reply ended inside, and leaves other fences alone", () => {
    expect(draw(`\`\`\`mermaid\n${FLOW}`)).toMatch(/^<figure class="diagram"/);
    expect(draw("```js\ngraph TD\n```")).toBe(
      "<code data-line>graph TD</code>",
    );
    // A language is an own key of `fences`, never an inherited one.
    expect(draw("```constructor\nx\n```")).toBe("<code data-line>x</code>");
  });

  it("escapes markup in labels", () => {
    const html = fences.mermaid(
      `flowchart TD\n  A["<script>alert(1)</script>"] --> B["<img src=x onerror=alert(1)>"]\n  click A href "javascript:alert(1)"`,
    )!;
    expect(html).not.toMatch(/<script|<img|<a[\s>]|<foreignObject/i);
    expect(html).toContain("&lt;script&gt;");
    expect(
      safeSvg(html.replace(/^<figure[^>]*>|<\/figure>$/g, "")),
    ).not.toBeNull();
  });

  it("remembers a diagram it has drawn", () => {
    const render = mermaidFence({ cache: 1 });
    const first = render(FLOW);
    expect(render(FLOW)).toBe(first);
    render("graph LR\n  A --> B");
    expect(render(FLOW)).toEqual(first);
  });
});

describe("safeSvg", () => {
  const ok = `<svg viewBox="0 0 1 1"><style>svg { --a: var(--fg); }</style><defs><marker id="m"></marker></defs><path d="M0 0" marker-end="url(#m)" /><text x="1">a &lt; b</text></svg>`;

  it("accepts drawing elements that refer only to themselves", () => {
    expect(safeSvg(ok)).toBe(ok);
  });

  it.each([
    ["a script", `<svg><script>alert(1)</script></svg>`],
    [
      "foreign content",
      `<svg><foreignObject><div></div></foreignObject></svg>`,
    ],
    ["a link", `<svg><a href="https://example.com"><text>x</text></a></svg>`],
    ["an event handler", `<svg><rect onclick="alert(1)" /></svg>`],
    [
      "an image reference",
      `<svg><rect fill="url(https://example.com/x.svg#a)" /></svg>`,
    ],
    ["a use of another file", `<svg><g xlink:href="x.svg#a"></g></svg>`],
    [
      "a stylesheet import",
      `<svg><style>@import url('https://example.com/x.css');</style></svg>`,
    ],
    ["markup in a stylesheet", `<svg><style><g></g></style></svg>`],
    ["an unclosed stylesheet", `<svg><style>svg { }</svg>`],
    ["a tag it cannot read", `<svg><rect x=1 /></svg>`],
    ["a stray angle bracket", `<svg><text>a < b</text></svg>`],
  ])("rejects %s", (_, svg) => {
    expect(safeSvg(svg)).toBeNull();
  });
});

describe("spaceArrows", () => {
  it.each([
    ["A-->B", ["A", "B"]],
    ["A-->|yes|B", ["A", "B"]],
    ["A[Start]-->B{Ok?}", ["Start", "Ok?"]],
    ["A---B", ["A", "B"]],
    ["A-.->B", ["A", "B"]],
    ["A-->B-->C", ["A", "B", "C"]],
    ["A --> B", ["A", "B"]],
  ])("reads %s as an edge between nodes", (edge, labels) => {
    expect(nodes(fences.mermaid(`graph LR\n  ${edge}`)!)).toEqual(labels);
  });

  it("leaves labels and other diagram types alone", () => {
    expect(spaceArrows(`graph LR\nA["x-->y"]-->B[a-->b]`)).toBe(
      `graph LR\nA["x-->y"] --> B[a-->b]`,
    );
    const sequence = "sequenceDiagram\n  A-->>B: hi";
    expect(spaceArrows(sequence)).toBe(sequence);
  });
});
