/**
 * The Worker's bindings and vars, as wrangler.wrapper.jsonc declares them.
 * Routes and stream scripts reach them as `context.platform.env`; nothing
 * here reads `process.env`.
 */
import type { Budget } from "../../do/budget.ts";
import type { ConversationLive } from "../../do/conversation-live.ts";
import type { ReaderData } from "../../do/reader-data.ts";

export interface Env {
  /** One object per reader: their conversations, memories, and files. */
  READER: DurableObjectNamespace<ReaderData>;
  /** One object per conversation: the reply being written, Stop, leases. */
  LIVE: DurableObjectNamespace<ConversationLive>;
  /** Counters: new readers per day, and sends per address. */
  BUDGET: DurableObjectNamespace<Budget>;
  /** The most readers that may start keeping data in one UTC day. */
  GENUI_DAILY_READERS?: string;
  /** The most messages one address may send in ten minutes. */
  GENUI_IP_SENDS?: string;
  /** The most messages with files one address may send in ten minutes. */
  GENUI_IP_UPLOADS?: string;
  /** The most new readers (sends without a visitor cookie) one address may start in a UTC day. */
  GENUI_IP_READERS?: string;
  /**
   * Requests per address per minute to anything that reaches the Worker:
   * the Workers Rate Limiting binding, which costs no Durable Object
   * request to check. Absent where the config declares none.
   */
  REQUESTS?: RateLimit;
  /** How long the scripted model waits between pieces of a reply, in ms. */
  DEMO_MODEL_DELAY_MS?: string;
  /** "1" in local development: a shared key of an unknown shape throws. */
  GENUI_DEVELOPMENT?: string;
  /** "0" for plain-http development on a browser that drops Secure cookies. */
  GENUI_SECURE_COOKIES?: string;
  /** Secret. Salts the hash of a client address before it names a counter. */
  IP_SALT?: string;
  /** Secret. Signs the visitor cookie. */
  SESSION_SECRET?: string;
}

/** What Bascik passes a route or a stream script as `context.platform` on Cloudflare. */
export interface Platform {
  name: string;
  env?: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The request context Bascik hands routes and stream scripts. */
export interface RequestContext {
  remoteIp?: string;
  platform?: Platform;
}

/** A whole number from a var, or the fallback when it is unset or not one. */
export function numberVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : fallback;
}

/** 24 hours: how long a reader's data is kept after their last write. */
export const RETENTION_MS = 24 * 60 * 60 * 1000;

/** What a write is refused with once the day's cap on new readers is reached. */
export const DEMO_FULL =
  "The demo is full for today. It takes new visitors again after midnight UTC.";

/** The UTC day, as `YYYY-MM-DD`: what names a day's counter. */
export const utcDay = (now = Date.now()): string =>
  new Date(now).toISOString().slice(0, 10);
