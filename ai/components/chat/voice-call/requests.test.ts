import { describe, expect, test } from "vitest";
import { postForm, viewUrl } from "./requests.ts";

describe("postForm", () => {
  test("posts the fields and the app's name as a form", async () => {
    const seen: { path: string; init: RequestInit }[] = [];
    const fetcher = (async (path: string, init: RequestInit) => {
      seen.push({ path, init });
      return new Response("ok");
    }) as typeof fetch;
    const signal = new AbortController().signal;
    await postForm(
      "books",
      "/api/voice-turn",
      { reader: "Hi", model: "Hello" },
      signal,
      fetcher,
    );
    expect(seen).toHaveLength(1);
    const { path, init } = seen[0]!;
    expect(path).toBe("/api/voice-turn");
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    const body = init.body as FormData;
    expect([...body.entries()]).toEqual([
      ["app", "books"],
      ["reader", "Hi"],
      ["model", "Hello"],
    ]);
  });

  test("a field named app replaces the app's name, as the component always did", async () => {
    let body: FormData | undefined;
    const fetcher = (async (_path: string, init: RequestInit) => {
      body = init.body as FormData;
      return new Response("ok");
    }) as typeof fetch;
    await postForm(
      "books",
      "/api/voice-tool",
      { app: "other" },
      undefined,
      fetcher,
    );
    // The later set wins, as it did when the component built the form itself.
    expect(body?.getAll("app")).toEqual(["other"]);
  });
});

describe("viewUrl", () => {
  test("names the app and the call, escaped", () => {
    expect(viewUrl("/voice-view", "books & more", "call/1")).toBe(
      "/voice-view?app=books%20%26%20more&call=call%2F1",
    );
  });

  test("is built on the route it is given, also one that has a query", () => {
    expect(viewUrl("https://example.com/shop/call-view", "books", "c1")).toBe(
      "https://example.com/shop/call-view?app=books&call=c1",
    );
    expect(viewUrl("/view?theme=dark", "books", "c1")).toBe(
      "/view?theme=dark&app=books&call=c1",
    );
  });
});
