/**
 * The token request against a real HTTP server that misbehaves: one that
 * never answers, one whose body never ends, and one whose body is far too long.
 */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { geminiLiveVoice } from "./gemini-live.ts";

const config = { system: "Be brief.", tools: [] };

describe("geminiLiveVoice, when the provider misbehaves", () => {
  let server: Server | undefined;

  async function serving(
    answer: (response: ServerResponse) => void,
  ): Promise<string> {
    server = createServer((request, response) => {
      request.resume();
      answer(response);
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
    server = undefined;
  });

  it("gives up on a provider that takes the request and never answers", async () => {
    const httpBase = await serving(() => {});
    const started = Date.now();
    await expect(
      geminiLiveVoice({ apiKey: "k", httpBase, timeoutMs: 150 }).createSession(
        config,
      ),
    ).rejects.toThrow("The voice provider did not answer in time.");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives up on an answer whose body never ends", async () => {
    const httpBase = await serving((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"name":');
    });
    await expect(
      geminiLiveVoice({ apiKey: "k", httpBase, timeoutMs: 150 }).createSession(
        config,
      ),
    ).rejects.toThrow("The voice provider did not answer in time.");
  });

  it("reads no more than a bounded part of an answer that goes on and on", async () => {
    let written = 0;
    let stopped = false;
    const httpBase = await serving((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"name":"');
      const piece = "a".repeat(64_000);
      const more = (): void => {
        if (stopped || response.destroyed) return;
        written += piece.length;
        response.write(piece, () => setImmediate(more));
      };
      response.on("close", () => (stopped = true));
      more();
    });
    await expect(
      geminiLiveVoice({ apiKey: "k", httpBase, timeoutMs: 5000 }).createSession(
        config,
      ),
    ).rejects.toThrow("The voice provider answered 200");
    stopped = true;
    // It stopped at the bound, long before the limit on time.
    expect(written).toBeLessThan(50_000_000);
  });

  it("still reads a token, and an error's message", async () => {
    const good = await serving((response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "auth_tokens/abc" }));
    });
    const ticket = await geminiLiveVoice({
      apiKey: "k",
      httpBase: good,
    }).createSession(config);
    expect(ticket.url).toContain("access_token=auth_tokens%2Fabc");
    server!.closeAllConnections();
    await new Promise((resolve) => server!.close(resolve));

    const bad = await serving((response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Key not valid." } }));
    });
    await expect(
      geminiLiveVoice({ apiKey: "k", httpBase: bad }).createSession(config),
    ).rejects.toThrow("The voice provider answered 403: Key not valid.");
  });
});
