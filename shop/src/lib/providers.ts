import { ShopError, now, type Env } from "./platform.ts";

export class ProviderError extends Error {
  provider: string;
  status: number;
  retryAt: number;
  constructor(
    provider: string,
    status: number,
    retryAfter: string | null = null,
  ) {
    super(`${provider} request failed (${status})`);
    this.provider = provider;
    this.status = status;
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
async function printfulResponse<T>(
  env: Pick<Env, "PRINTFUL_TOKEN" | "PRINTFUL_STORE_ID"> &
    Partial<Pick<Env, "SHOP_MODE">>,
  path: string,
  data?: unknown,
): Promise<{
  data: T;
  paging?: { total: number; offset: number; limit: number };
}> {
  if (
    data !== undefined &&
    /\/confirmation(?:\?|$)/.test(path) &&
    env.SHOP_MODE !== "live"
  )
    throw new ShopError(
      "Printful production confirmation is forbidden outside live mode.",
      403,
    );
  const response = await fetch(`https://api.printful.com/v2${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${env.PRINTFUL_TOKEN}`,
      "X-PF-Store-Id": env.PRINTFUL_STORE_ID,
      "Content-Type": "application/json",
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new ProviderError(
      "Printful",
      response.status,
      response.headers.get("retry-after"),
    );
  const payload = (await response.json()) as {
    data: T;
    paging?: { total: number; offset: number; limit: number };
  };
  if (!payload || typeof payload !== "object" || !("data" in payload))
    throw new ProviderError("Printful response", 502);
  return payload;
}
export async function printful<T>(
  env: Pick<Env, "PRINTFUL_TOKEN" | "PRINTFUL_STORE_ID"> &
    Partial<Pick<Env, "SHOP_MODE">>,
  path: string,
  data?: unknown,
): Promise<T> {
  return (await printfulResponse<T>(env, path, data)).data;
}
export async function printfulList<T>(
  env: Pick<Env, "PRINTFUL_TOKEN" | "PRINTFUL_STORE_ID">,
  path: string,
): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  for (let page = 0; page < 100; ++page) {
    const payload = await printfulResponse<T[]>(
      env,
      `${path}${path.includes("?") ? "&" : "?"}limit=100&offset=${offset}`,
    );
    if (
      !Array.isArray(payload.data) ||
      !payload.paging ||
      !Number.isSafeInteger(payload.paging.total) ||
      payload.paging.total < 0 ||
      !Number.isSafeInteger(payload.paging.limit) ||
      payload.paging.limit <= 0 ||
      payload.paging.offset !== offset
    )
      throw new ProviderError("Printful pagination", 502);
    results.push(...payload.data);
    if (results.length >= payload.paging.total) return results;
    if (!payload.data.length)
      throw new ProviderError("Printful pagination", 502);
    offset += payload.paging.limit;
  }
  throw new ProviderError("Printful pagination limit", 502);
}
export async function stripe<T>(
  env: Env,
  path: string,
  params?: URLSearchParams,
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
    "Stripe-Version": "2025-02-24.acacia",
  };
  if (params) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: params ? "POST" : "GET",
    headers,
    body: params,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new ProviderError(
      "Stripe",
      response.status,
      response.headers.get("retry-after"),
    );
  return (await response.json()) as T;
}
export function cents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new ShopError(
      "The shipping provider returned an invalid price.",
      502,
    );
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result < 0 || result > 1_000_000)
    throw new ShopError(
      "The shipping provider returned an invalid price.",
      502,
    );
  return result;
}
