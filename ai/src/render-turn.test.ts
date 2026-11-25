import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "./catalog.ts";
import type { ChatMessage, Tool, ToolPart } from "./model.ts";
import { escapeHtml } from "./render.ts";
import { renderMessage, renderToolPart, renderTurn } from "./render-turn.ts";
import type { TurnEvent } from "./turn.ts";

const catalog: Catalog = new Map(
  [
    describeComponent(
      "tool-note.html",
      `<p><span data-bascik-slot></span></p>`,
    )!,
  ].map((entry) => [entry.name, entry]),
);

const tools: Tool[] = [
  {
    name: "look_up",
    description: "",
    inputSchema: { type: "object", properties: {} },
    note: (input) => `<tool-note>Looking up ${input.title}</tool-note>`,
    run: () => "",
  },
];

const part = (
  state: ToolPart["state"],
  extra: Partial<ToolPart> = {},
): ToolPart => ({
  type: "tool",
  id: "call_1",
  name: "look_up",
  input: { title: "Dune" },
  state,
  ...extra,
});

async function* play(events: TurnEvent[]): AsyncGenerator<TurnEvent> {
  yield* events;
}

describe("renderToolPart", () => {
  it("wraps a call in an element that names its tool and state", () => {
    expect(renderToolPart(part("running"), catalog, { tools })).toBe(
      `<div class="part" data-part="call_1" data-tool="look_up" data-state="running"><tool-note>Looking up Dune</tool-note></div>`,
    );
  });

  it("renders the note through the catalog, so a tool cannot write markup with it", () => {
    const html = renderToolPart(
      part("done", { input: { title: "<script>x</script>" } }),
      catalog,
      { tools },
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("lets the app draw a state, and falls back to the note when it draws nothing", () => {
    const view = (drawn: ToolPart) =>
      drawn.state === "approval-requested"
        ? `<form data-call="${escapeHtml(drawn.id)}"></form>`
        : null;
    expect(
      renderToolPart(part("approval-requested"), catalog, { tools, view }),
    ).toContain(`<form data-call="call_1"></form>`);
    expect(renderToolPart(part("done"), catalog, { tools, view })).toContain(
      "Looking up Dune",
    );
    expect(renderToolPart(part("done"), catalog)).toBe(
      `<div class="part" data-part="call_1" data-tool="look_up" data-state="done"></div>`,
    );
  });

  it("escapes the id and the tool name", () => {
    const html = renderToolPart(
      part("done", { id: `"><b>`, name: `"><i>` }),
      catalog,
    );
    expect(html).not.toMatch(/<b>|<i>/);
  });
});

describe("renderTurn", () => {
  it("sends text as it arrives and a tool part each time its state changes", async () => {
    const chunks: string[] = [];
    for await (const chunk of renderTurn(
      play([
        { type: "text", delta: "Look" },
        { type: "text", delta: "ing **now" },
        { type: "tool", part: part("running") },
        { type: "tool", part: part("done", { output: "x" }) },
        { type: "text", delta: "Found it." },
      ]),
      catalog,
      { tools },
    )) {
      chunks.push(chunk);
    }
    expect(chunks[0]).toBe("Look");
    // The text before a call is finished off when the call starts.
    expect(chunks.join("")).toBe(
      `Looking **now` +
        `<div class="part" data-part="call_1" data-tool="look_up" data-state="running"><tool-note>Looking up Dune</tool-note></div>` +
        `<div class="part" data-part="call_1" data-tool="look_up" data-state="done"><tool-note>Looking up Dune</tool-note></div>` +
        `Found it.`,
    );
    for (const chunk of chunks.slice(1)) expect(chunk).not.toBe("");
  });
});

describe("renderMessage", () => {
  it("draws each part once, in the state it was stored in", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: "",
      parts: [
        { type: "text", text: "Looking." },
        part("done", { output: "x" }),
        { type: "text", text: "**Found** it." },
      ],
    };
    expect(renderMessage(message, catalog, { tools })).toBe(
      `Looking.<div class="part" data-part="call_1" data-tool="look_up" data-state="done"><tool-note>Looking up Dune</tool-note></div><strong>Found</strong> it.`,
    );
  });

  it("renders a message stored before parts existed", () => {
    expect(
      renderMessage({ role: "assistant", content: "**Hi**" }, catalog),
    ).toBe("<strong>Hi</strong>");
  });
});
