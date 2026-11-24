/**
 * Which model answers. The server offers what it is configured with, and the
 * visitor picks one from that list; the choice is a cookie holding an id
 * from the list, never a URL or a key.
 *
 *   Offline script      always there: no model, a fixed script per app
 *   Claude              when ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) is set
 *   Ollama              when it answers at OLLAMA_HOST (default 127.0.0.1:11434)
 *   LM Studio           when it answers at LMSTUDIO_HOST (default 127.0.0.1:1234)
 *   OpenAI-compatible   when OPENAI_BASE_URL is set (with OPENAI_API_KEY if it needs one)
 *
 * Set GENUI_LOCAL_MODELS=0 on a deployed server so it does not look for
 * Ollama or LM Studio on its own machine.
 */
import type { Model } from "@bascik/genui";
import type { ChatApp } from "./apps.ts";

export interface ModelChoice {
  /** `provider:model`, the value kept in the cookie. */
  id: string;
  provider: string;
  /** The provider's name as the selector shows it. */
  group: string;
  name: string;
}

interface Endpoint {
  provider: string;
  group: string;
  baseUrl: string;
  apiKey?: string;
  /** Names to offer without asking the server. */
  models?: string[];
}

type Environment = Record<string, string | undefined>;

export const OFFLINE: ModelChoice = {
  id: "offline:script",
  provider: "offline",
  group: "No model",
  name: "Offline script",
};

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** `host:port` or a full URL, as an OpenAI-compatible API root. */
const apiRoot = (host: string): string => {
  const url = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return `${url.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1`;
};

/** The OpenAI-compatible servers this environment names. */
export function endpointsFrom(env: Environment): Endpoint[] {
  const endpoints: Endpoint[] = [];
  if (env.GENUI_LOCAL_MODELS !== "0") {
    endpoints.push(
      {
        provider: "ollama",
        group: "Ollama (this machine)",
        baseUrl: apiRoot(env.OLLAMA_HOST || "127.0.0.1:11434"),
      },
      {
        provider: "lmstudio",
        group: "LM Studio (this machine)",
        baseUrl: apiRoot(env.LMSTUDIO_HOST || "127.0.0.1:1234"),
      },
    );
  }
  if (env.OPENAI_BASE_URL) {
    endpoints.push({
      provider: "openai",
      group: env.OPENAI_LABEL || "OpenAI-compatible",
      baseUrl: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
      models: list(env.OPENAI_MODELS),
    });
  }
  return endpoints;
}

const CLAUDE_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];
const hasClaude = (env: Environment): boolean =>
  Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

/** Everything the visitor may pick, the offline script first. */
export async function availableModels(
  env: Environment = process.env,
  send: typeof fetch = fetch,
): Promise<ModelChoice[]> {
  const { listOpenAiCompatibleModels } = await import("@bascik/genui/openai");
  const choices: ModelChoice[] = [OFFLINE];
  if (hasClaude(env)) {
    const names = list(env.ANTHROPIC_MODELS);
    for (const name of names.length > 0 ? names : CLAUDE_MODELS) {
      choices.push({
        id: `anthropic:${name}`,
        provider: "anthropic",
        group: "Claude (Anthropic API)",
        name,
      });
    }
  }
  const found = await Promise.all(
    endpointsFrom(env).map(async (endpoint) => ({
      endpoint,
      names:
        endpoint.models && endpoint.models.length > 0
          ? endpoint.models
          : await listOpenAiCompatibleModels({
              baseUrl: endpoint.baseUrl,
              apiKey: endpoint.apiKey,
              fetch: send,
            }),
    })),
  );
  for (const { endpoint, names } of found) {
    for (const name of names.slice(0, 50)) {
      choices.push({
        id: `${endpoint.provider}:${name}`,
        provider: endpoint.provider,
        group: endpoint.group,
        name,
      });
    }
  }
  return choices;
}

/* ---- A short cache, so a page load does not probe local servers twice ---- */

const CACHE_MS = 10_000;
let cached: { at: number; choices: Promise<ModelChoice[]> } | undefined;

export function listModels(): Promise<ModelChoice[]> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    cached = { at: Date.now(), choices: availableModels() };
  }
  return cached.choices;
}

/* ---- The visitor's choice ---- */

const COOKIE = /(?:^|;\s*)model=([^;]{1,200})(?:;|$)/;

/** The id in the request's `model` cookie, undecoded and unchecked. */
export function requestedModel(request: Request): string | undefined {
  const value = COOKIE.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!value) return undefined;
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * The model that answers this request: the visitor's choice when the server
 * still offers it, else Claude when a key is set, else the offline script.
 */
export function pickModel(
  choices: ModelChoice[],
  requested: string | undefined,
): ModelChoice {
  return (
    choices.find((choice) => choice.id === requested) ??
    choices.find((choice) => choice.provider === "anthropic") ??
    OFFLINE
  );
}

export const modelCookie = (id: string): string =>
  `model=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;

/** Build the `Model` for a choice. `app.offline` answers for the script. */
export async function modelFor(
  choice: ModelChoice,
  app: ChatApp,
  env: Environment = process.env,
): Promise<Model> {
  if (choice.provider === "offline") return app.offline;
  if (choice.provider === "anthropic") {
    const { anthropicModel } = await import("@bascik/genui/anthropic");
    return anthropicModel({ model: choice.name });
  }
  const endpoint = endpointsFrom(env).find(
    (candidate) => candidate.provider === choice.provider,
  );
  if (!endpoint) return app.offline;
  const { openAiCompatibleModel } = await import("@bascik/genui/openai");
  return openAiCompatibleModel({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: choice.name,
  });
}
