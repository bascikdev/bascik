/**
 * The chat's routes, through the Worker `bascik --build --target
 * cloudflare` wrote (`yarn build` first), over the real Durable Objects: the
 * limits in src/lib/limits.ts hold for every path Bascik routes to a
 * handler, and a reply a page starts is handed to the platform's waitUntil.
 */
import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import bascik from "bascik-worker-built";
import { chatOf, route } from "../src/lib/chat.ts";
import type { Env, RequestContext } from "../src/lib/env.ts";

const bindings = env as unknown as Env;

let address = 0;
/** A client address no other test sends from, so each test has its own counters. */
const nextAddress = () => `192.0.2.${++address}`;

interface Call {
  ip: string;
  method?: string;
  cookie?: string;
  type?: string;
  body?: string;
  length?: string | null;
}

async function call(
  path: string,
  { ip, method = "POST", cookie, type, body, length }: Call,
  withEnv: Env = bindings,
): Promise<Response> {
  const headers = new Headers({ "cf-connecting-ip": ip });
  if (cookie) headers.set("cookie", cookie);
  if (body !== undefined) {
    headers.set("content-type", type ?? "application/x-www-form-urlencoded");
    if (length !== null) {
      headers.set(
        "content-length",
        length ?? String(new TextEncoder().encode(body).byteLength),
      );
    }
  }
  const ctx = createExecutionContext();
  const response = await bascik.fetch(
    new Request(`https://example.test${path}`, { method, headers, body }),
    withEnv,
    ctx,
  );
  await response.body?.cancel();
  await waitOnExecutionContext(ctx);
  return response;
}

const MESSAGE = "app=books&text=hi";

/** The visitor and chat cookies a response set, as a Cookie header. */
const cookiesOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** A multipart send with one small text file, `size` bytes of it. */
function upload(size: number): { type: string; body: string } {
  const boundary = "bookshop-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="app"',
    "",
    "books",
    `--${boundary}`,
    'Content-Disposition: form-data; name="text"',
    "",
    "What is in this file?",
    `--${boundary}`,
    'Content-Disposition: form-data; name="files"; filename="notes.txt"',
    "Content-Type: text/plain",
    "",
    "x".repeat(size),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  // Media types are case-insensitive: formData() reads this one too.
  return { type: `Multipart/Form-Data; boundary=${boundary}`, body };
}

describe("the chat's routes", () => {
  it("counts every path Bascik routes to send against one window", async () => {
    const limited: Env = { ...bindings, GENUI_IP_SENDS: "3" };
    const paths = [
      "/api/send",
      "/api/send/",
      "/api/%73end",
      "//api//send",
      "/%61pi/send",
    ];
    // Each path reaches the send route.
    for (const path of paths) {
      const sent = await call(
        path,
        { ip: nextAddress(), body: MESSAGE },
        limited,
      );
      expect(sent.status, path).toBe(303);
    }
    // And one address's sends count together, whichever path they took.
    const ip = nextAddress();
    for (const path of paths.slice(0, 3)) {
      expect((await call(path, { ip, body: MESSAGE }, limited)).status).toBe(
        303,
      );
    }
    for (const path of paths) {
      const refused = await call(path, { ip, body: MESSAGE }, limited);
      expect(refused.status, path).toBe(429);
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    }
  });

  it("answers 411 and 413 on any spelling of an API path, before the chat reads the body", async () => {
    for (const path of ["/api/send", "/%61pi/send", "//api//send/"]) {
      const unsized = await call(path, {
        ip: nextAddress(),
        body: MESSAGE,
        length: null,
      });
      expect(unsized.status, path).toBe(411);
      const huge = await call(path, {
        ip: nextAddress(),
        body: MESSAGE,
        length: String(3 * 1024 * 1024),
      });
      expect(huge.status, path).toBe(413);
    }
  });

  it("answers 405 for a method the routes do not take", async () => {
    const refused = await call("/api/send", {
      ip: nextAddress(),
      method: "PUT",
      body: MESSAGE,
    });
    expect(refused.status).toBe(405);
  });

  it("counts a send with files against the uploads window, whatever the case of its media type", async () => {
    const limited: Env = { ...bindings, GENUI_IP_UPLOADS: "2" };
    const ip = nextAddress();
    let cookie: string | undefined;
    for (let n = 0; n < 2; n++) {
      const sent = await call(
        "/api/send",
        { ip, cookie, ...upload(40 * 1024) },
        limited,
      );
      expect(sent.status).toBe(303);
      cookie ??= cookiesOf(sent);
    }
    const refused = await call(
      "/api/send",
      { ip, cookie, ...upload(40 * 1024) },
      limited,
    );
    expect(refused.status).toBe(429);
    // A send without files still fits the address's window.
    expect(
      (await call("/api/send", { ip, cookie, body: MESSAGE }, limited)).status,
    ).toBe(303);
  });

  it("lets one address start only a few new readers a day, and its known reader goes on", async () => {
    const limited: Env = { ...bindings, GENUI_IP_READERS: "2" };
    const ip = nextAddress();
    const first = await call("/api/send", { ip, body: MESSAGE }, limited);
    expect(first.status).toBe(303);
    expect(
      (await call("/api/send", { ip, body: MESSAGE }, limited)).status,
    ).toBe(303);
    // A third send with no visitor cookie is a third new reader.
    const refused = await call("/api/send", { ip, body: MESSAGE }, limited);
    expect(refused.status).toBe(429);
    // The reader the first send made is not new.
    expect(
      (
        await call(
          "/api/send",
          { ip, cookie: cookiesOf(first), body: MESSAGE },
          limited,
        )
      ).status,
    ).toBe(303);
    // Another address starts its own.
    expect(
      (await call("/api/send", { ip: nextAddress(), body: MESSAGE }, limited))
        .status,
    ).toBe(303);
  });

  it("counts approve and result as sends: each one starts a model turn", async () => {
    const limited: Env = { ...bindings, GENUI_IP_SENDS: "2" };
    const ip = nextAddress();
    const form = "app=books&call=nope&verdict=deny";
    expect(
      (await call("/api/approve", { ip, body: form }, limited)).status,
    ).not.toBe(429);
    expect(
      (await call("/api/result", { ip, body: form }, limited)).status,
    ).not.toBe(429);
    expect(
      (await call("/api/send", { ip, body: MESSAGE }, limited)).status,
    ).toBe(429);
  });

  it("answers file and stop with 404 before any store call when there is no visitor cookie", async () => {
    const ip = nextAddress();
    expect((await call("/api/file?id=x", { ip, method: "GET" })).status).toBe(
      404,
    );
    expect((await call("/api/stop", { ip, body: "app=books" })).status).toBe(
      404,
    );
    // A cookie that is not one this server issues counts as none.
    expect(
      (
        await call("/api/file?id=x", {
          ip,
          method: "GET",
          cookie: "visitor=not-an-id",
        })
      ).status,
    ).toBe(404);
  });

  it("refuses sends with 503 when IP_SALT is not set", async () => {
    const unsalted: Env = { ...bindings, IP_SALT: undefined };
    expect(
      (await call("/api/send", { ip: nextAddress(), body: MESSAGE }, unsalted))
        .status,
    ).toBe(503);
  });
});

describe("a reply a page starts", () => {
  it("is handed to the platform's waitUntil, and is stored once it settles", async () => {
    const handed: Promise<unknown>[] = [];
    const context: RequestContext = {
      platform: {
        name: "cloudflare",
        env: bindings,
        waitUntil: (promise) => handed.push(promise),
      },
    };
    const ip = nextAddress();
    const send = route("send");
    const sent = await send(
      new Request("https://example.test/api/send", {
        method: "POST",
        headers: {
          "cf-connecting-ip": ip,
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(MESSAGE.length),
        },
        body: MESSAGE,
      }),
      context,
    );
    expect(sent.status).toBe(303);
    const page = new Request("https://example.test/", {
      headers: { cookie: cookiesOf(sent) },
    });
    const { chat, host } = chatOf(context);
    const { turn } = await chat.thread(page, host);
    expect(turn).toBeDefined();
    // The reply this request started, and nothing else.
    expect(handed).toEqual([turn!.over]);
    await handed[0];
    const { messages, turn: after } = await chat.thread(
      new Request(page),
      host,
    );
    expect(after).toBeUndefined();
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
