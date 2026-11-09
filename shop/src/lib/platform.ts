import type { D1Database } from "@cloudflare/workers-types";
export interface Env {
  DB: D1Database;
  SHOP_ORIGIN: string;
  SHOP_ENABLED: string;
  SHOP_MODE: "test" | "live";
  SHOP_FULFILLMENT_ENABLED?: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ORDER_TOKEN_SECRET: string;
  PRINTFUL_TOKEN: string;
  PRINTFUL_STORE_ID: string;
  PRINTFUL_WEBHOOK_SECRET: string;
  PRINTFUL_WEBHOOK_PUBLIC_KEY: string;
  EMAIL_FROM: string;
  ALERT_EMAIL: string;
  SUPPORT_EMAIL: string;
  TAX_CODE_SHIRT: string;
  TAX_CODE_HAT: string;
  EMAIL?: {
    send(message: {
      from: string | { name: string; email: string };
      to: string;
      subject: string;
      text: string;
      html?: string;
      replyTo?: string;
    }): Promise<{ messageId: string }>;
  };
  JOBS?: { send(message: { orderId: string }): Promise<void> };
}
export interface Context {
  platform?: { env?: unknown };
}
export class ShopError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export class ProviderError extends Error {
  provider: string;
  status: number;
  retryAt: number;
  path: string;
  constructor(
    provider: string,
    status: number,
    retryAfter: string | null = null,
    path = "",
  ) {
    super(`${provider} request failed (${status})`);
    this.name = "ProviderError";
    this.provider = provider;
    this.status = status;
    this.path = path.split("?")[0];
    const seconds =
      retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const deadline = Number.isSafeInteger(seconds)
      ? now() + seconds
      : Math.ceil(Date.parse(retryAfter ?? "") / 1000);
    this.retryAt = Number.isSafeInteger(deadline)
      ? Math.max(now(), deadline)
      : 0;
  }
}
export function environment(context: Context): Env {
  const value = context.platform?.env;
  if (!value || typeof value !== "object" || !("DB" in value))
    throw new ShopError("Shop storage is not configured.", 503);
  return value as Env;
}
export const now = () => Math.floor(Date.now() / 1000);
export function enabled(env: Env) {
  if (env.SHOP_ENABLED !== "true")
    throw new ShopError(
      "Checkout is not open yet. Please check back soon.",
      503,
    );
  configuration(env);
}
export function configuration(env: Env) {
  if (env.SHOP_MODE !== "live" && env.SHOP_MODE !== "test")
    throw new ShopError("Payment mode is not configured.", 503);
  for (const key of [
    "SHOP_ORIGIN",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "ORDER_TOKEN_SECRET",
    "PRINTFUL_TOKEN",
    "PRINTFUL_STORE_ID",
    "EMAIL_FROM",
    "ALERT_EMAIL",
    "SUPPORT_EMAIL",
    "TAX_CODE_SHIRT",
    "TAX_CODE_HAT",
  ] as const)
    if (!env[key])
      throw new ShopError("Shop configuration is incomplete.", 503);
  if (env.ORDER_TOKEN_SECRET.length < 32)
    throw new ShopError("Order access is not configured.", 503);
  if (
    !/^txcd_\d+$/.test(env.TAX_CODE_SHIRT) ||
    !/^txcd_\d+$/.test(env.TAX_CODE_HAT)
  )
    throw new ShopError("Product tax classification is not configured.", 503);
  const live =
    env.STRIPE_SECRET_KEY.startsWith("sk_live_") ||
    env.STRIPE_SECRET_KEY.startsWith("rk_live_");
  if ((env.SHOP_MODE === "live") !== live)
    throw new ShopError("Payment mode configuration does not match.", 503);
  if (env.SHOP_MODE === "test" && !/^(sk|rk)_test_/.test(env.STRIPE_SECRET_KEY))
    throw new ShopError("A sandbox payment key is required.", 503);
}
export async function boundedText(
  request: Request,
  limit: number,
): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ShopError("Request too large.", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ShopError("Invalid UTF-8 request body.");
  }
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new ShopError("Use JSON for this request.", 415);
  const text = await boundedText(request, 16_384);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ShopError("Invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ShopError("Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function sameOrigin(request: Request, env: Env) {
  if (request.headers.get("origin") !== new URL(env.SHOP_ORIGIN).origin)
    throw new ShopError("Request origin not allowed.", 403);
}
export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export function handler(
  action: (request: Request, env: Env) => Promise<Response>,
) {
  return async (request: Request, context: Context): Promise<Response> => {
    try {
      return await action(request, environment(context));
    } catch (error) {
      if (error instanceof ShopError) {
        console.warn("Shop request rejected", {
          path: new URL(request.url).pathname,
          status: error.status,
        });
        return json({ error: error.message }, error.status);
      }
      console.error("Shop request failed", {
        path: new URL(request.url).pathname,
        requestId: request.headers.get("cf-ray"),
        type: error instanceof Error ? error.name : "unknown",
        ...(error instanceof ProviderError
          ? {
              provider: error.provider,
              providerStatus: error.status,
              providerPath: error.path,
              retryAt: error.retryAt,
            }
          : {}),
      });
      if (
        error instanceof ProviderError &&
        error.provider === "Printful" &&
        error.path === "/shipping-rates" &&
        ["/api/quote", "/api/checkout-shipping"].includes(
          new URL(request.url).pathname,
        ) &&
        [400, 422].includes(error.status)
      )
        return json(
          {
            error:
              "Printful could not quote shipping for this cart and address. Check your state/province, postal code, and delivery address.",
          },
          422,
        );
      return json(
        {
          error: "The shop could not complete this request. Please try again.",
        },
        502,
      );
    }
  };
}
export async function digest(text: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export async function hmac(secret: string, text: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
export async function orderToken(env: Env, id: string) {
  return `${id}.${await hmac(env.ORDER_TOKEN_SECRET, `order:${id}`)}`;
}
/** How long a ticket (the short-lived form of an order token) stays valid. */
export const TICKET_LIFETIME_SECONDS = 600;
const ORDER_ID = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/;
const ticketSignature = (env: Env, id: string, exp: number) =>
  hmac(env.ORDER_TOKEN_SECRET, `order-ticket:${id}.${exp}`);
/**
 * A ticket is `<id>.<exp>.<hmac>`: the order token exchanged for a short-lived
 * form that can travel in a URL, so only a value that expires in minutes
 * reaches request logs. The `order-ticket:` prefix keeps a ticket from
 * passing as a token and the other way round.
 */
export async function orderTicket(env: Env, id: string) {
  const exp = now() + TICKET_LIFETIME_SECONDS;
  return `${id}.${exp}.${await ticketSignature(env, id, exp)}`;
}
/** `{ id, expired }` for a ticket with a good signature, `null` otherwise. */
export async function verifyTicket(
  env: Env,
  ticket: string,
): Promise<{ id: string; expired: boolean } | null> {
  if (!env.ORDER_TOKEN_SECRET) return null;
  const match = /^([a-f0-9-]+)\.([0-9]{1,12})\.([a-f0-9]{64})$/.exec(ticket);
  if (!match || !ORDER_ID.test(match[1])) return null;
  const [, id, expText, signature] = match;
  const exp = Number(expText);
  if (!equal(signature, await ticketSignature(env, id, exp))) return null;
  return { id, expired: exp < now() };
}
export async function rateLimit(request: Request, env: Env) {
  const bucket = Math.floor(now() / 60);
  const id = await digest(
    `${request.headers.get("cf-connecting-ip") ?? "local"}:${bucket}`,
  );
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits(id,count,expires_at) VALUES (?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1 RETURNING count",
  )
    .bind(id, now() + 120)
    .first<{ count: number }>();
  if (!row || row.count > 20)
    throw new ShopError("Too many requests. Please wait a minute.", 429);
}
