# Tools & Approval

A tool is something a model can call to get data or to do something. `runTurn()` is the loop that runs the calls, and every call is a part of the reply with a state the page can show: running, done, failed, waiting for the reader.

## A message is its parts

A reply is not one string. It is text the model wrote and the tool calls it made, in order:

```ts
type MessagePart =
  | { type: "text"; text: string; spoken?: boolean }
  | {
      type: "tool";
      id: string;
      name: string;
      input: Record<string, unknown>;
      state:
        | "approval-requested"
        | "client-requested"
        | "approved"
        | "denied"
        | "running"
        | "done"
        | "failed";
      output?: string;
      error?: string;
    };
```

A text part marked `spoken` is words from a [voice call](/ai/voice#a-call-with-a-speech-model), shown as plain text. Parts are what you store, what the model is shown again, and what the page renders. A tool call therefore looks the same while it runs, after a reload, and to the model.

## Define a tool

A tool has a name, a description the model reads, a JSON Schema for its input, and a `run` function that returns text for the model:

```ts
import type { Tool } from "@bascik/ai";

export const tools: Tool[] = [
  {
    name: "run_sql",
    description: "Run one read-only SELECT and get the rows as JSON.",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "One SELECT" } },
      required: ["sql"],
    },
    // What stands for the call in the reply, in the model's own format.
    note: () => `<tool-note>Querying the database</tool-note>`,
    run: (input) => JSON.stringify(runSql(String(input.sql))),
  },
];
```

The model's input is untrusted. A call is checked against the schema before `run` is called, and a call that fails the check, or names a tool that does not exist, is reported to the model as a failed call and never run.

## Run a turn

`runTurn()` asks the model, runs the tools it calls, and asks again until the model has nothing more to do. `renderTurn()` turns what happens into HTML a stream script can yield:

```ts
import { renderTurn, runTurn } from "@bascik/ai";

const turn = runTurn({ model, system, messages, tools, signal });
try {
  yield * renderTurn(turn.events, catalog, { tools });
} finally {
  // turn.message is filled in as the turn goes, so a reply the reader
  // walked away from is still worth storing.
  await save(turn.message);
}
```

The loop is not inside a model adapter. A `Model` is one round: it yields text and tool calls and never runs anything. So Claude, a local model, and a scripted stand-in all get the same states and the same stored message.

## A tool call on the page

Each tool part is sent as an element that names its tool and state:

```html
<div class="part" data-part="call_1" data-tool="run_sql" data-state="running">
  ...
</div>
```

When a call's state changes while the reply streams, the part is sent again. A page that only grows cannot replace what it already sent, so one CSS rule hides the running version once a finished one follows it:

```css
.part[data-state="running"]:has(~ .part:not([data-state="running"])) {
  display: none;
}
```

What is inside the element is yours. By default it is the tool's `note`. Pass `view` to draw a state yourself, with [`html`](/html-helpers) so every value is escaped. It can return any of your components:

```ts
import { html } from "@bascik/bascik/html";

yield *
  renderTurn(turn.events, catalog, {
    tools,
    view: (part) =>
      part.state === "failed"
        ? html`<tool-status
            >${part.name} failed: ${part.error ?? ""}</tool-status
          >`
        : null, // null: use the tool's note
  });
```

For a stored message, `renderMessage(message, catalog, options)` draws each part once, in the state it was stored in.

## Ask before a tool runs

Mark a tool that changes something with `approval: true`:

```ts
{
  name: "place_hold",
  description: "Hold one copy of a book at the front desk.",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
  approval: true,
  run: (input) => placeHold(String(input.title)),
}
```

When the model calls it, nothing runs. The turn stops, the message is marked `awaiting: "reader"`, and the part's state is `approval-requested`. Draw that state as a form. The package's `tool-approval` component is one, with two buttons that post `verdict=approve` or `verdict=deny`:

```ts
view: (part) =>
  part.state === "approval-requested"
    ? html`<tool-approval
        data-bascik-prop-call="${part.id}"
        data-bascik-prop-action="${part.name}"
      ></tool-approval>`
    : null,
```

The route it posts to records the answer on the stored part and redirects to the page:

```ts
// src/api/approve.ts
import { decideToolCall } from "@bascik/ai";

export const POST = async (request: Request): Promise<Response> => {
  const form = await request.formData();
  const conversation = await loadConversation(request);
  const call = String(form.get("call"));
  const approve = form.get("verdict") === "approve";
  if (!conversation || !decideToolCall(conversation.messages, call, approve)) {
    return new Response("No tool call is waiting for that answer.", {
      status: 400,
    });
  }
  await saveConversation(conversation);
  return new Response(null, { status: 303, headers: { location: "/" } });
};
```

`decideToolCall` only accepts an answer for a call that is waiting, once. When no call in the message is waiting, the message becomes `awaiting: "model"`, and `turnPending(messages)` is true: the page runs `runTurn` again with the same messages, and the turn carries on. It runs a call the reader allowed, tells the model about one they refused, and asks the model to continue.

Approval is stored state, not page state. The reader can close the tab and answer tomorrow. If they send another message instead, call `abandonToolCalls(messages)` first, which refuses every waiting call so nothing runs later.

## Tools the reader's browser answers

Some things only the reader's side knows: their local time, a choice, a file. A tool with `client: true` has no `run`:

```ts
{
  name: "local_time",
  description: "The reader's local time and time zone.",
  inputSchema: { type: "object", properties: {} },
  client: true,
}
```

The turn stops at the call with the state `client-requested`. Draw it as a form with a field named for the result, and a script that fills the field in and sends the form:

```html
<form id="form" method="post" action="/api/result">
  <input type="hidden" name="call" data-bascik-attr-value="call" />
  <label>
    What time is it for you?
    <input id="output" name="output" required />
  </label>
  <button>Send</button>
  <script>
    const now = new Date();
    document.getElementById("output").value =
      `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")} ` +
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.getElementById("form").requestSubmit();
  </script>
</form>
```

With scripts on, the reader sees the answer arrive. With scripts off, the same form asks them, and they type it. Either way the route gets one form post, and `answerToolCall(messages, call, output)` stores it as the tool's output. The result is the reader's text: treat it like anything else a reader types.

## A reply that outlives its page

A turn that runs inside the request stops when the reader leaves, and a reload starts a second reply. To avoid both, run the turn once per conversation and let pages read it. `createBroadcast()` is a stream with many readers, each from the start:

```ts
import { createBroadcast, renderTurn, runTurn } from "@bascik/ai";

const html = createBroadcast<string>();
// Not awaited: the reply is written whether or not anyone is reading.
void (async () => {
  const turn = runTurn({ model, system, messages, tools });
  try {
    for await (const chunk of renderTurn(turn.events, catalog, { tools })) {
      html.push(chunk);
    }
  } finally {
    await save(turn.message);
    html.end();
  }
})();

// In the stream script of every page that shows this conversation:
yield * html.subscribe();
```

Keep the broadcast in a map by conversation id while the turn runs. A reload in the middle of a reply then joins it from its first chunk, a second tab shows the same reply, and a reply is finished and stored when nobody is watching. This is one process's memory. With several servers, see [Running on Several Servers](/ai/scaling).
