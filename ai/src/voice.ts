/**
 * Voice sessions with a speech-to-speech model.
 *
 * A text reply is a request and a growing page. A voice conversation is a
 * long two-way audio connection, so it has its own shape:
 *
 * - **The browser connects with a ticket.** A short-lived, one-use ticket
 *   the server made, with the session's setup locked in. The API key never
 *   leaves the server. Where the provider issues such a ticket itself
 *   (Gemini Live), the audio goes direct; where it does not (Azure Voice
 *   Live), the ticket is for a relay on the server.
 * - **Everything that runs or renders goes through the server.** When the
 *   model calls a tool, the browser asks the server to run it. When the
 *   model wants to show something, it calls the `show` tool with markup in
 *   the usual reply format, and the server renders it with the usual
 *   renderer. So the trust boundary, the catalog, tool input checks, and
 *   approval are the same ones a text reply has.
 * - **What was said is stored as a message.** The transcript, the tool calls
 *   and what was shown become one assistant message made of parts, so a
 *   reload shows the conversation, components included.
 */
import { catalogPrompt, type Catalog } from "./catalog.ts";
import {
  invalidToolInput,
  type ChatMessage,
  type MessagePart,
  type Tool,
  type ToolPart,
} from "./model.ts";
import { renderToolPart, type TurnRenderOptions } from "./render-turn.ts";
import { renderText } from "./render.ts";

/** What a browser needs to open one voice session. It holds no API key. */
export interface VoiceTicket {
  /** Which wire protocol the browser speaks: `gemini-live` or `azure-voice-live`. */
  protocol: string;
  /** The WebSocket address, with a short-lived credential in it. */
  url: string;
  /** The first message to send once connected, or null when there is none. */
  setup: unknown;
  /** Who is on the line, as the reader is told: the provider and its model. */
  label?: string;
}

export interface VoiceSessionConfig {
  /** The system prompt, usually `voicePrompt(...)` after the app's own instructions. */
  system: string;
  /** The tools the model may call, usually `voiceTools(...)`. */
  tools: readonly Tool[];
}

/** A speech-to-speech provider: it turns a session's config into a ticket. */
export interface VoiceProvider {
  protocol: string;
  createSession(config: VoiceSessionConfig): Promise<VoiceTicket>;
}

/** The name of the tool a voice model calls to put something on screen. */
export const SHOW_TOOL = "show";

/**
 * The name of the tool a voice model calls to fill in and send a form on the
 * reader's screen, when the reader says their answer instead of pressing it.
 * The reader's browser does it, where the reader can see it happen.
 */
export const FILL_TOOL = "fill_form";

/**
 * The tools a voice session offers: the app's own, `show`, and `fill_form`.
 * A client tool is left out: it is answered by a form in a text reply, which
 * a voice session has no turn for.
 */
export function voiceTools(tools: readonly Tool[]): Tool[] {
  return [
    ...tools.filter(
      (tool) =>
        !tool.client && tool.name !== SHOW_TOOL && tool.name !== FILL_TOOL,
    ),
    {
      name: SHOW_TOOL,
      description:
        "Put something on the reader's screen while you talk: cards, a chart, a table, a diagram, buttons. `markup` is written in the component format from your instructions. Call it whenever a visual answers better than speech, and say in a few words what you are showing.",
      inputSchema: {
        type: "object",
        properties: {
          markup: {
            type: "string",
            description: "Components and short text, in the component format",
          },
        },
        required: ["markup"],
      },
    },
    {
      name: FILL_TOOL,
      description:
        "Fill in and send the form on the reader's screen for them, when they say their answer aloud instead of pressing it. `press` is the words on the button or option to press, such as Correct. `text` is what to type into the form's text box first, such as a note they dictated. Use only what the reader said: never choose for them, and never guess. It cannot answer a question about allowing an action: the reader presses that themselves.",
      inputSchema: {
        type: "object",
        properties: {
          press: {
            type: "string",
            description: "The words on the button or option to press",
          },
          text: {
            type: "string",
            description:
              "What to type into the form's text box before pressing",
          },
          field: {
            type: "string",
            description:
              "The label of the text box, when the form has more than one",
          },
        },
        required: ["press"],
      },
    },
  ];
}

/**
 * The part of a system prompt that teaches a speaking model the catalog: it
 * talks, and it shows components by calling `show`.
 */
export function voicePrompt(
  catalog: Catalog,
  options: Parameters<typeof catalogPrompt>[1] = {},
): string {
  return [
    "You are in a spoken conversation. The reader hears you and sees a screen beside the conversation.",
    "Everything you say is spoken aloud by a voice. Speak briefly and naturally: one to three sentences. Never say markup, tags, tables, or long lists.",
    `The reader answers a form on the screen by speaking, and you enter it: when they say their answer ("yes, that is correct", "the second one", "add a note that..."), call ${FILL_TOOL} with the button or option that matches what they said. That is the reader's own answer, sent by the form in whatever shape it uses, and it is the normal way a form is answered here. Never ask the reader to type, to press it themselves, or to say a message in a special format, and never refuse because their words are not in some format. Ask again only when you cannot tell which button they mean.`,
    `When the reader asks to see something differently ("another way", "a different view", "can you change how that looks") without naming a component, change the kind of view, not the wording: pick other components from the catalog than the ones on screen. Cards can become a table, a table a chart, a list steps, a long answer a diagram. Keep the same content, and say in a few words what you changed it to. Showing the same components again is never the answer to that request.`,
    `The only way to put anything on the screen is the ${SHOW_TOOL} tool. Put every component you want shown, buttons included, in one ${SHOW_TOOL} call per turn. Its markup uses the format below. Say in a few words what you are showing, then let the screen carry the detail.`,
    "",
    "The format for markup:",
    "",
    catalogPrompt(catalog, options),
  ].join("\n");
}

/** A voice turn being recorded: what was called and shown since the last one was stored. */
export interface VoiceTurn {
  parts: MessagePart[];
  /**
   * The components of the view shown last, kept from turn to turn, so a
   * model that shows the same kind of view again can be told so.
   */
  lastView?: string[];
}

/** The component tags a piece of markup uses, each once, in order of name. */
const componentsIn = (markup: string): string[] =>
  [
    ...new Set(
      [...markup.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)[\s/>]/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();

export const newVoiceTurn = (): VoiceTurn => ({ parts: [] });

export interface VoiceToolRequest {
  /** The provider's id for the call. */
  id: string;
  name: string;
  input: unknown;
  /** The reader's answer, when this call was waiting for their approval. */
  decision?: "approve" | "deny";
}

export interface VoiceToolResult {
  /** `done`, `failed`, `denied`, or `approval-requested` when the reader has to answer first. */
  state: ToolPart["state"];
  /** What to tell the model. Absent while the call waits for approval. */
  output?: string;
  /** What to put on the reader's screen for this call, if anything. */
  html: string;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Run one tool call a voice model made, and record it in the turn. This is
 * the server's side of a voice session: the input is checked, a tool that
 * needs approval waits for the reader, and `show` is rendered through the
 * catalog like any reply.
 */
export async function runVoiceTool(
  turn: VoiceTurn,
  request: VoiceToolRequest,
  tools: readonly Tool[],
  catalog: Catalog,
  options: TurnRenderOptions = {},
): Promise<VoiceToolResult> {
  const id = SAFE_ID.test(request.id)
    ? request.id
    : `call_${crypto.randomUUID()}`;
  const offered = voiceTools(tools);
  const view = { ...options, tools: offered };

  if (request.name === FILL_TOOL) {
    // The form is in the reader's browser, which is where this is done.
    return {
      state: "failed",
      output: "Error: a form is filled in by the reader's browser.",
      html: "",
    };
  }
  if (request.name === SHOW_TOOL && !request.decision) {
    const markup =
      typeof request.input === "object" && request.input !== null
        ? (request.input as { markup?: unknown }).markup
        : undefined;
    if (typeof markup !== "string" || !markup.trim()) {
      return {
        state: "failed",
        output: "Error: markup is required.",
        html: "",
      };
    }
    // Stored as text, so a reload renders it through the same catalog.
    turn.parts.push({ type: "text", text: markup });
    // A reader who asks to "see it another way" often gets the same view
    // back. The model is told when a view repeats, and decides what that means.
    const view = componentsIn(markup);
    const repeated =
      view.length > 0 && view.join() === (turn.lastView ?? []).join();
    turn.lastView = view;
    return {
      state: "done",
      output: repeated
        ? `Shown on the reader's screen. This view uses the same components as the one before it (${view.join(", ")}). If the reader asked to see it a different way, that was not a different way: call ${SHOW_TOOL} again now with other components from the catalog. If they asked for new content, carry on.`
        : "Shown on the reader's screen.",
      html: renderText(markup, catalog, options),
    };
  }

  // A decision is about a call that is already waiting in this turn.
  let part = turn.parts.find(
    (candidate): candidate is ToolPart =>
      candidate.type === "tool" && candidate.id === id,
  );
  if (request.decision) {
    if (part?.state !== "approval-requested") {
      return {
        state: "failed",
        output: "Error: nothing is waiting.",
        html: "",
      };
    }
    part.state = request.decision === "approve" ? "approved" : "denied";
  } else {
    if (part) {
      return { state: "failed", output: "Error: already called.", html: "" };
    }
    const tool = offered.find((candidate) => candidate.name === request.name);
    const invalid = tool
      ? invalidToolInput(tool.inputSchema, request.input)
      : `there is no tool named ${request.name}`;
    part = {
      type: "tool",
      id,
      name: request.name,
      input:
        typeof request.input === "object" && request.input !== null
          ? (request.input as Record<string, unknown>)
          : {},
      state: "running",
    };
    turn.parts.push(part);
    if (invalid || !tool) {
      part.state = "failed";
      part.error = `Invalid call: ${invalid}.`;
    } else if (
      typeof tool.approval === "function"
        ? tool.approval(part.input)
        : tool.approval === true
    ) {
      part.state = "approval-requested";
      return { state: part.state, html: renderToolPart(part, catalog, view) };
    }
  }

  if (part.state === "running" || part.state === "approved") {
    const tool = offered.find((candidate) => candidate.name === part.name);
    try {
      if (!tool?.run) throw new Error(`There is no tool named ${part.name}.`);
      part.output = await tool.run(part.input, {});
      part.state = "done";
    } catch (error) {
      part.error = error instanceof Error ? error.message : "The tool failed.";
      part.state = "failed";
    }
  }
  return {
    state: part.state,
    output:
      part.state === "done"
        ? (part.output ?? "")
        : part.state === "denied"
          ? "The reader declined this action. It was not done."
          : `Error: ${part.error ?? "the tool failed"}`,
    html: renderToolPart(part, catalog, view),
  };
}

/**
 * End a voice turn: the messages to store for it. What the reader said, then
 * one assistant message with what the model said, called, and showed. A call
 * the reader never answered is stored as refused.
 */
export function voiceMessages(
  turn: VoiceTurn,
  said: { reader: string; model: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const reader = said.reader.trim();
  if (reader) messages.push({ role: "user", content: reader });
  const spoken = said.model.trim();
  const parts: MessagePart[] = [
    ...(spoken ? [{ type: "text" as const, text: spoken, spoken: true }] : []),
    ...turn.parts.map((part) =>
      part.type === "tool" && part.state === "approval-requested"
        ? { ...part, state: "denied" as const }
        : part,
    ),
  ];
  if (parts.length) {
    messages.push({ role: "assistant", content: spoken, parts });
  }
  turn.parts = [];
  return messages;
}
