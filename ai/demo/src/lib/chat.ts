/**
 * What the demo chooses for its chat: four apps, its catalog folders, the
 * model its visitors pick, and the voice providers its environment names.
 * The rest (conversations, sessions, live replies, every handler) is
 * `createChat` from `@bascik/ai/app`, one per app.
 */
import { html, type SafeHtml } from "@bascik/bascik/html";
import { join } from "node:path";
import {
  readCatalog,
  type Catalog,
  type Model,
  type ToolPart,
  type VoiceProvider,
} from "@bascik/ai";
import { createChat, fileMemories, fileStore, type Chat } from "@bascik/ai/app";
import { savedMemory } from "@bascik/ai/memory";
import { diskFiles } from "@bascik/ai/files";
import { MERMAID_PROMPT, mermaidFence } from "@bascik/ai/mermaid";
import {
  SANDBOX_LANGUAGE,
  SANDBOX_PROMPT,
  sandboxFence,
} from "@bascik/ai/sandbox";
import { APPS, type ChatApp } from "./apps.ts";
import { listModels, modelFor, pickModel, requestedModel } from "./models.ts";

/* ---- Which app a request is for ---- */

const byPath = (pathname: string): ChatApp | undefined => {
  const path = pathname.replace(/\/$/, "") || "/";
  return APPS.find((app) => app.path === path);
};

/**
 * A page request names its app by its own path, or by `?app=` (the memory
 * page, which is not one app's path). A form post names it in an `app`
 * field, or, for a form the model generated, by the page it was sent from.
 */
export function appFor(request: Request, named?: string | null): ChatApp {
  const queried = new URL(request.url).searchParams.get("app");
  const fromField = APPS.find((app) => app.id === (named ?? queried));
  if (fromField) return fromField;
  const own = byPath(new URL(request.url).pathname);
  if (own) return own;
  const referer = request.headers.get("referer");
  if (referer && URL.canParse(referer)) {
    const from = byPath(new URL(referer).pathname);
    if (from) return from;
  }
  return APPS[0]!;
}

/* ---- Voice: a spoken conversation with a speech-to-speech model ---- */

/**
 * The voice provider this server is set up with, or null. With
 * GEMINI_API_KEY set it is Gemini Live. The key stays here: a browser gets a
 * one-use ticket from /api/voice-session and connects to the provider itself.
 */
export async function loadVoice(
  named?: string | null,
): Promise<VoiceProvider | null> {
  const providers = await voiceProviders();
  return (
    providers.find((provider) => provider.protocol === named) ??
    providers[0] ??
    null
  );
}

/**
 * The providers this server is set up for, Azure first. Made once: the Azure
 * one runs a relay, which has to outlive a request.
 */
const voiceHolder = globalThis as { genuiVoices?: Promise<VoiceProvider[]> };
function voiceProviders(): Promise<VoiceProvider[]> {
  return (voiceHolder.genuiVoices ??= (async () => {
    const providers: VoiceProvider[] = [];
    const env = process.env;
    if (env.AZURE_VOICE_LIVE_ENDPOINT || env.AZURE_VOICE_LIVE_WS) {
      const { azureVoiceLiveVoice } =
        await import("@bascik/ai/azure-voice-live");
      providers.push(
        azureVoiceLiveVoice({
          model: env.AZURE_VOICE_LIVE_MODEL,
          voice: env.AZURE_VOICE_LIVE_VOICE,
          // With no key and no token given, a developer's own Azure sign-in.
          ...(env.AZURE_VOICE_LIVE_API_KEY || env.AZURE_VOICE_LIVE_TOKEN
            ? {}
            : {
                token: async () =>
                  (await import("./azure-cli.ts")).azureCliToken(
                    "https://ai.azure.com/.default",
                  ),
              }),
          relay: { port: Number(env.AZURE_VOICE_LIVE_RELAY_PORT ?? 0) },
          // A test points this at a stand-in for the provider.
          wsBase: env.AZURE_VOICE_LIVE_WS,
        }),
      );
    }
    if (env.GEMINI_API_KEY) {
      const { geminiLiveVoice } = await import("@bascik/ai/gemini-live");
      providers.push(
        geminiLiveVoice({
          model: env.GEMINI_LIVE_MODEL,
          // A test points these at a stand-in for the provider.
          httpBase: env.GEMINI_LIVE_HTTP,
          wsBase: env.GEMINI_LIVE_WS,
        }),
      );
    }
    return providers;
  })());
}

/* ---- Catalog and model ---- */

/** The components a model may write: everything in src/genui. */
export const loadCatalog = (): Promise<Catalog> =>
  (catalog ??= readCatalog([
    // The catalog the package brings. A project that ran
    // `bascik add @bascik/ai` has it at src/components/catalog instead.
    join(import.meta.dirname, "..", "..", "..", "components", "catalog"),
    // This demo's own: books, review forms, diagrams.
    join(import.meta.dirname, "..", "genui"),
  ]));

let catalog: Promise<Catalog> | undefined;

/** One renderer for every reply, so a diagram is drawn once and remembered. */
const mermaid = mermaidFence();
/** Whole pages the model writes, for the apps that allow them, each in a sandboxed frame. */
const sandbox = sandboxFence();

/** `place_hold` as "Place hold": what a tool call is called on the page. */
const actionName = (part: ToolPart): string => {
  const words = part.name.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * How a tool call looks in each state. A call that waits for the reader is
 * an approval card; one that was refused or failed is a line that says so.
 * A call that is running or done is shown as its tool's own note (null).
 */
function toolView(app: ChatApp, part: ToolPart): SafeHtml | null {
  switch (part.state) {
    case "approval-requested":
      return html`<tool-approval
        data-bascik-prop-app="${app.id}"
        data-bascik-prop-call="${part.id}"
        data-bascik-prop-action="${actionName(part)}"
        >${Object.entries(part.input).map(
          ([name, value]) =>
            html`<dt>${name}</dt>
              <dd>${String(value)}</dd>`,
        )}</tool-approval
      >`;
    case "client-requested":
      // A client tool is drawn by the component that can answer it.
      return part.name === "local_time"
        ? html`<client-local-time
            data-bascik-prop-app="${app.id}"
            data-bascik-prop-call="${part.id}"
          ></client-local-time>`
        : null;
    case "denied":
      return html`<tool-status
        >You did not allow: ${actionName(part)}</tool-status
      >`;
    case "failed":
      return html`<tool-status
        >${actionName(part)} failed: ${part.error ?? ""}</tool-status
      >`;
    case "done": {
      // What was just remembered is shown as the words themselves, with a
      // button that takes it back.
      const saved = savedMemory(part);
      return saved
        ? html`<memory-note
            data-bascik-prop-app="${app.id}"
            data-bascik-prop-memory="${saved.id}"
            >${saved.text}</memory-note
          >`
        : null;
    }
    default:
      return null;
  }
}

/** The model the visitor picked, from what this server offers (lib/models.ts). */
export async function loadModel(
  app: ChatApp,
  request: Request,
): Promise<Model> {
  const choice = pickModel(await listModels(), requestedModel(request));
  return modelFor(choice, app);
}

/* ---- One chat per app ---- */

/** One place for every app's conversations: .data/<app>/<visitor>/<id>.json. */
const DATA_DIR = join(process.cwd(), ".data");

const chats = new Map<string, Chat>();

/** The chat of an app: its tools, instructions, and page, over its own store. */
export function chatFor(app: ChatApp): Chat {
  let chat = chats.get(app.id);
  if (!chat) {
    chat = createChat({
      id: app.id,
      store: fileStore(join(DATA_DIR, app.id)),
      // Attachments are on for the books app only.
      ...(app.id === "books"
        ? { files: diskFiles(join(DATA_DIR, `${app.id}-files`)) }
        : {}),
      catalog: loadCatalog,
      model: (request) => loadModel(app, request),
      tools: app.tools,
      // What each reader told this app, kept apart from its conversations.
      memory: fileMemories(join(DATA_DIR, "memory", app.id)),
      system: app.instructions,
      fencePrompts: {
        mermaid: MERMAID_PROMPT,
        ...(app.openEnded ? { [SANDBOX_LANGUAGE]: SANDBOX_PROMPT } : {}),
      },
      // How replies are drawn, live and from history: the HTML elements the
      // app may pass through, ```mermaid fences as diagrams (and, when the app
      // is open-ended, ```html-app fences as sandboxed pages), and its tool calls.
      render: {
        elements: app.elements,
        fences: {
          mermaid,
          ...(app.openEnded ? { [SANDBOX_LANGUAGE]: sandbox } : {}),
        },
        view: (part) => toolView(app, part),
      },
      voice: loadVoice,
      page: app.path,
    });
    chats.set(app.id, chat);
  }
  return chat;
}

/** The text system prompt of an app, for the stress script. */
export const systemPrompt = (app: ChatApp): Promise<string> =>
  chatFor(app).systemPrompt();

type FormHandler =
  | "send"
  | "approve"
  | "answer"
  | "forget"
  | "stop"
  | "open"
  | "file"
  | "voiceSession"
  | "voiceTool"
  | "voiceTurn";

/**
 * A route for a handler of the app the request is for. Every form names its
 * app in an `app` field; the handler then reads the same form again, so this
 * reads a copy.
 */
export const route =
  (handler: FormHandler) =>
  async (request: Request): Promise<Response> => {
    let named: unknown = null;
    try {
      named = (await request.clone().formData()).get("app");
    } catch {
      // Not a form: the handler says so.
    }
    return chatFor(appFor(request, typeof named === "string" ? named : null))[
      handler
    ](request);
  };
