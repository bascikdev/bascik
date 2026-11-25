/**
 * The wrapper Worker (worker.ts) in local workerd, with the Budget object
 * the bindings name and a stand-in for the generated Bascik Worker (the
 * `bascik-worker` alias in vite.config.ts): what it refuses before Bascik
 * sees a request, and what it passes on.
 */
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import wrapper from "../worker.ts";
import type { Env } from "../src/lib/env.ts";
import { MAX_BODY_BYTES } from "../src/lib/guards.ts";
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

const sendForm = (ip: string, withEnv?: Env) => {
  const body = "app=books&text=hi";
  return call(
    "/api/send",
    {
      method: "POST",
      ip,
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(body.length),
      },
    },
    withEnv,
  );
};

describe("the wrapper Worker", () => {
  it("passes pages, other API paths and a send that fits on to Bascik", async () => {
    reached.length = 0;
    expect((await call("/")).status).toBe(200);
    expect((await call("/api/file?id=x")).status).toBe(200);
    expect((await sendForm(nextAddress())).status).toBe(200);
    expect(reached).toEqual(["GET /", "GET /api/file", "POST /api/send"]);
  });

  it("answers 405 for a method /api/ does not take, and leaves pages to Bascik", async () => {
    reached.length = 0;
    const refused = await call("/api/send", { method: "PUT", body: "x" });
    expect(refused.status).toBe(405);
    expect(refused.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(reached).toEqual([]);
    // Outside /api/ the wrapper does not judge the method.
    expect((await call("/", { method: "OPTIONS" })).status).toBe(200);
  });

  it("answers 411 for a POST that streams its body without a length", async () => {
    reached.length = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("text=hi"));
        controller.close();
      },
    });
    const refused = await call("/api/send", {
      method: "POST",
      body,
      ip: nextAddress(),
    });
    expect(refused.status).toBe(411);
    expect(reached).toEqual([]);
  });

  it("answers 413 for a body declared over the cap, without reading it", async () => {
    reached.length = 0;
    const refused = await call("/api/send", {
      method: "POST",
      ip: nextAddress(),
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(Math.ceil(MAX_BODY_BYTES) + 1),
      },
      body: "--x--",
    });
    expect(refused.status).toBe(413);
    expect(reached).toEqual([]);
  });

  it("answers 429 for the 31st send from one address in a window, and not for another address", async () => {
    const ip = nextAddress();
    // 30 at once: the Budget object counts them exactly.
    const statuses = await Promise.all(
      Array.from({ length: 30 }, () => sendForm(ip).then((r) => r.status)),
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(30);
    const refused = await sendForm(ip);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await sendForm(nextAddress())).status).toBe(200);
  });

  it("counts sends with files against their own, smaller cap", async () => {
    const ip = nextAddress();
    const upload = () =>
      call("/api/send", {
        method: "POST",
        ip,
        headers: {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(64 * 1024),
        },
        body: "x".repeat(64 * 1024),
      });
    for (let n = 0; n < 10; n++) expect((await upload()).status).toBe(200);
    expect((await upload()).status).toBe(429);
    // A send without files still fits the address's window.
    expect((await sendForm(ip)).status).toBe(200);
  });

  it("refuses sends with 503 when IP_SALT is not set, and still serves pages", async () => {
    const unsalted: Env = { ...bindings, IP_SALT: undefined };
    reached.length = 0;
    expect((await sendForm(nextAddress(), unsalted)).status).toBe(503);
    expect((await call("/", {}, unsalted)).status).toBe(200);
    expect(reached).toEqual(["GET /"]);
  });
});
