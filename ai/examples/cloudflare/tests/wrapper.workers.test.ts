/**
 * The wrapper Worker (worker.ts) in local workerd, with the rate limiter the
 * config names and a stand-in for the generated Bascik Worker (the
 * `bascik-worker` alias in vite.config.ts): every request it passes on is
 * counted per address, whatever its path. The chat's own limits run in its
 * routes, and tests/routes.workers.test.ts runs them through the real
 * generated Worker.
 */
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import wrapper from "../worker.ts";
import type { Env } from "../src/lib/env.ts";
import { reached } from "./fake-bascik-worker.ts";

const bindings = env as unknown as Env;

let address = 0;
/** A client address no other test sends from, so each test has its own window. */
const nextAddress = () => `198.51.100.${++address}`;

async function call(
  path: string,
  init: RequestInit & { ip?: string } = {},
  withEnv: Env = bindings,
): Promise<Response> {
  const { ip, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (ip) headers.set("cf-connecting-ip", ip);
  const ctx = createExecutionContext();
  const response = await wrapper.fetch(
    new Request(`https://example.test${path}`, { ...rest, headers }),
    withEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** The config's cap: requests per address per minute. */
const LIMIT = 120;

describe("the wrapper Worker", () => {
  it("passes pages and API paths on to Bascik, whatever their method", async () => {
    reached.length = 0;
    const ip = nextAddress();
    expect((await call("/", { ip })).status).toBe(200);
    expect((await call("/api/file?id=x", { ip })).status).toBe(200);
    expect((await call("/api/send", { method: "PUT", ip })).status).toBe(200);
    expect(reached).toEqual(["GET /", "GET /api/file", "PUT /api/send"]);
  });

  it("answers 429 past the per-minute cap for any spelling of a path, and not for another address", async () => {
    const ip = nextAddress();
    const paths = [
      "/",
      "/api/send",
      "/api/send/",
      "/%61pi/send",
      "//api//send",
    ];
    for (let n = 0; n < LIMIT; n++) {
      const response = await call(paths[n % paths.length]!, { ip });
      expect(response.status, `request ${n + 1}`).toBe(200);
    }
    for (const path of paths) {
      const refused = await call(path, { ip });
      expect(refused.status, path).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
    }
    expect((await call("/", { ip: nextAddress() })).status).toBe(200);
  });

  it("counts the addresses of one IPv6 /64 as one client", async () => {
    const prefix = "2001:db8:77:1";
    for (let n = 0; n < LIMIT; n++) {
      const ip = `${prefix}::${(n + 1).toString(16)}`;
      expect((await call("/", { ip })).status, ip).toBe(200);
    }
    expect((await call("/", { ip: `${prefix}::ffff` })).status).toBe(429);
    expect((await call("/", { ip: "2001:db8:77:2::1" })).status).toBe(200);
  });

  it("passes everything on where the config declares no rate limiter", async () => {
    const unlimited: Env = { ...bindings, REQUESTS: undefined };
    const ip = nextAddress();
    for (let n = 0; n < LIMIT + 1; n++) {
      expect((await call("/", { ip }, unlimited)).status).toBe(200);
    }
  });
});
