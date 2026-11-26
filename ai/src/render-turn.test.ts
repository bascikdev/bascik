import { describe, expect, it } from "vitest";
import { describeComponent, type Catalog } from "./catalog.ts";
import type { ChatMessage, Tool, ToolPart } from "./model.ts";
import { esc } from "@bascik/bascik/html";
import {
  renderMessage,
  renderToolPart,
  renderTurn,
  type TurnRenderOptions,
} from "./render-turn.ts";
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
        ? `<form data-call="${esc(drawn.id)}"></form>`
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

  it("holds a whole stored message to one component budget", () => {
    const many = `<tool-note>x</tool-note>\n`.repeat(400);
    const message: ChatMessage = {
      role: "assistant",
      content: "",
      parts: [
        { type: "text", text: many },
        part("done", { output: "x" }),
        { type: "text", text: many },
        { type: "text", text: many },
      ],
    };
    const html = renderMessage(message, catalog, { tools });
    // 300 by default, the tool's note among them; far under Bascik's 1000.
    expect(html.match(/<tool-note/g)).toHaveLength(300);
    expect(html).toContain("left out to keep this reply a reasonable size.");
  });

  it("holds a live turn to one component budget across its text parts", async () => {
    const many = `<tool-note>x</tool-note>\n`.repeat(200);
    let html = "";
    for await (const chunk of renderTurn(
      play([
        { type: "text", delta: many },
        { type: "tool", part: part("running") },
        { type: "text", delta: many },
      ]),
      catalog,
      { tools, maxComponents: 250 },
    )) {
      html += chunk;
    }
    // 250 in all, the tool part's note among them.
    expect(html.match(/<tool-note/g)).toHaveLength(250);
    expect(html).toContain("151 more items were left out");
  });

  it.each([
    ["the note in every state", undefined],
    [
      "the note only once the call is done",
      (drawn: ToolPart) => (drawn.state === "running" ? "<i>…</i>" : null),
    ],
  ])(
    "shows the same components live as on reload, with %s",
    async (_, view) => {
      const many = `<tool-note>x</tool-note>\n`.repeat(200);
      const options = { tools, view, maxComponents: 250 };
      let live = "";
      for await (const chunk of renderTurn(
        play([
          { type: "text", delta: many },
          { type: "tool", part: part("running") },
          { type: "tool", part: part("done", { output: "x" }) },
          { type: "text", delta: many },
        ]),
        catalog,
        options,
      )) {
        live += chunk;
      }
      const stored = renderMessage(
        {
          role: "assistant",
          content: "",
          parts: [
            { type: "text", text: many },
            part("done", { output: "x" }),
            { type: "text", text: many },
          ],
        },
        catalog,
        options,
      );
      // The running part is hidden once the done one follows it.
      expect(
        live.replace(
          /<div class="part"[^>]*data-state="running">.*?<\/div>/,
          "",
        ),
      ).toBe(stored);
    },
  );

  it("charges a part's running sending only until a finished part hides it", async () => {
    let html = "";
    const events: TurnEvent[] = [
      { type: "tool", part: part("running") },
      { type: "tool", part: part("running") },
      { type: "tool", part: part("done", { output: "x" }) },
      {
        type: "text",
        delta: "<tool-note>a</tool-note>\n<tool-note>b</tool-note>",
      },
    ];
    for await (const chunk of renderTurn(play(events), catalog, {
      tools,
      maxComponents: 3,
    })) {
      html += chunk;
    }
    expect(html).toContain("<tool-note>a</tool-note>");
    expect(html).toContain("<tool-note>b</tool-note>");
    expect(html).not.toContain("left out");
  });

  it("keeps charging a finished sending that a later one does not hide", async () => {
    let html = "";
    const events: TurnEvent[] = [
      { type: "tool", part: part("approval-requested") },
      { type: "tool", part: part("done", { output: "x" }) },
      {
        type: "text",
        delta: "<tool-note>a</tool-note>\n<tool-note>b</tool-note>",
      },
    ];
    for await (const chunk of renderTurn(play(events), catalog, {
      tools,
      maxComponents: 3,
    })) {
      html += chunk;
    }
    // Both sendings stay in view: the CSS hides only a running one.
    expect(html).toContain("<tool-note>a</tool-note>");
    expect(html).not.toContain("<tool-note>b</tool-note>");
    expect(html).toContain("1 more item was left out");
  });

  describe("with calls running side by side", () => {
    const wide: Tool[] = [
      {
        name: "look_up",
        description: "",
        inputSchema: { type: "object", properties: {} },
        note: () => `<tool-note>x</tool-note>\n`.repeat(200),
        run: () => "",
      },
    ];
    const a = (state: ToolPart["state"]) => part(state, { id: "a" });
    const b = (state: ToolPart["state"]) => part(state, { id: "b" });
    const shown = (html: string) =>
      html.replace(
        // A note can hold a `<div>`, so a part runs to the next part's start.
        /<div class="part"[^>]*data-state="running">.*?<\/div>(?=<div class="part"|$)/gs,
        () => "",
      );
    const live = async (events: TurnEvent[], options: TurnRenderOptions) => {
      let html = "";
      for await (const chunk of renderTurn(play(events), catalog, options)) {
        html += chunk;
      }
      return html;
    };
    const views = [
      ["the note in every state", undefined],
      [
        "the note only once the call is done",
        (drawn: ToolPart) => (drawn.state === "running" ? "<i>…</i>" : null),
      ],
    ] as const;

    it.each(views)(
      "shows the same components live as on reload, with %s",
      async (_, view) => {
        const options = { tools: wide, view, maxComponents: 300 };
        // As a turn runs them: every call running, then every call done.
        const html = await live(
          [
            { type: "tool", part: a("running") },
            { type: "tool", part: b("running") },
            { type: "tool", part: a("done") },
            { type: "tool", part: b("done") },
          ],
          options,
        );
        const stored = renderMessage(
          { role: "assistant", content: "", parts: [a("done"), b("done")] },
          catalog,
          options,
        );
        expect(stored.match(/<tool-note/g)).toHaveLength(300);
        expect(shown(html)).toBe(stored);
      },
    );

    it.each(views)(
      "never shows more than the budget, whatever order the calls finish in, with %s",
      async (_, view) => {
        const options = { tools: wide, view, maxComponents: 300 };
        for (const order of [
          ["a", "b", "c", "a", "b", "c"],
          ["a", "b", "c", "c", "b", "a"],
          ["a", "b", "b", "c", "a", "c"],
          ["a", "a", "b", "c", "c", "b"],
        ]) {
          const sent = new Set<string>();
          const events: TurnEvent[] = order.map((id) => {
            const state = sent.has(id) ? "done" : "running";
            sent.add(id);
            return { type: "tool", part: part(state, { id }) };
          });
          events.push({ type: "text", delta: "<tool-note>y</tool-note>" });
          const html = shown(await live(events, options));
          expect(
            html.match(/<tool-note/g)!.length,
            order.join(""),
          ).toBeLessThanOrEqual(300);
        }
      },
    );

    /**
     * How many components stay in view once the turn has streamed, read as
     * the CSS rule reads the page: a running part is hidden when any part
     * after it is not running, and nothing else is hidden. Each value
     * `renderTurn` yields is text, then at most one part to its end.
     */
    const inView = async (events: TurnEvent[], options: TurnRenderOptions) => {
      const pieces: { running: boolean | null; count: number }[] = [];
      for await (const chunk of renderTurn(play(events), catalog, options)) {
        const at = chunk.indexOf('<div class="part"');
        const text = at < 0 ? chunk : chunk.slice(0, at);
        pieces.push({
          running: null,
          count: text.split("<tool-note").length - 1,
        });
        if (at >= 0) {
          const sent = chunk.slice(at);
          pieces.push({
            running: /^<div class="part"[^>]*data-state="running"/.test(sent),
            count: sent.split("<tool-note").length - 1,
          });
        }
      }
      return pieces.reduce(
        (sum, piece, index) =>
          piece.running &&
          pieces.slice(index + 1).some((later) => later.running === false)
            ? sum
            : sum + piece.count,
        0,
      );
    };

    it.each([
      [["x:approval-requested", "y:done", "x:running", "x:done"]],
      [["a:done", "b:done", "a:failed"]],
      [["a:running", "a:running", "b:running"]],
    ])(
      "never shows more than the budget when a part is sent again, for %j",
      async (order) => {
        const events: TurnEvent[] = order.map((sent) => {
          const [id, state] = sent.split(":") as [string, ToolPart["state"]];
          return { type: "tool", part: part(state, { id }) };
        });
        events.push({ type: "text", delta: "<tool-note>y</tool-note>" });
        expect(
          await inView(events, { tools: wide, maxComponents: 300 }),
        ).toBeLessThanOrEqual(300);
      },
    );

    it.each(views)(
      "never shows more than the budget, whatever a stream sends, with %s",
      async (_, view) => {
        const half: Tool[] = [
          {
            ...wide[0]!,
            note: () => `<tool-note>x</tool-note>\n`.repeat(100),
          },
        ];
        const options = { tools: half, view, maxComponents: 150 };
        const steps: TurnEvent[] = [
          { type: "text", delta: `<tool-note>t</tool-note>\n`.repeat(40) },
          ...["a", "b"].flatMap((id) =>
            (["running", "done", "approval-requested"] as const).map(
              (state): TurnEvent => ({
                type: "tool",
                part: part(state, { id }),
              }),
            ),
          ),
        ];
        // Every stream of four steps.
        for (let n = 0; n < steps.length ** 4; n++) {
          const events = [0, 1, 2, 3].map(
            (digit) =>
              steps[Math.floor(n / steps.length ** digit) % steps.length]!,
          );
          expect(await inView(events, options), String(n)).toBeLessThanOrEqual(
            150,
          );
        }
      },
    );
  });

  it("renders a message stored before parts existed", () => {
    expect(
      renderMessage({ role: "assistant", content: "**Hi**" }, catalog),
    ).toBe("<strong>Hi</strong>");
  });
});
