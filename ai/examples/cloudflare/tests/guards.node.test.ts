import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  SEND_WINDOW_MS,
  addressHash,
  carriesFiles,
  checkRequest,
  sendWindow,
  tooMany,
} from "../src/lib/guards.ts";

const post = (headers: Record<string, string>) =>
  new Request("https://example.test/api/send", { method: "POST", headers });

describe("guards", () => {
  it("lets GET, HEAD and a POST with a length that fits through", () => {
    expect(
      checkRequest(new Request("https://example.test/api/file")),
    ).toBeNull();
    expect(
      checkRequest(
        new Request("https://example.test/api/file", { method: "HEAD" }),
      ),
    ).toBeNull();
    expect(checkRequest(post({ "content-length": "120" }))).toBeNull();
  });

  it("answers 405 for another method, with Allow", () => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const refused = checkRequest(
        new Request("https://example.test/api/send", { method }),
      );
      expect(refused?.status, method).toBe(405);
      expect(refused?.headers.get("allow")).toBe("GET, HEAD, POST");
    }
  });

  it("answers 411 for a POST that does not declare its length", () => {
    expect(checkRequest(post({}))?.status).toBe(411);
    expect(checkRequest(post({ "content-length": "12abc" }))?.status).toBe(411);
  });

  it("answers 413 past the cap", () => {
    expect(
      checkRequest(
        post({ "content-length": String(Math.floor(MAX_BODY_BYTES)) }),
      ),
    ).toBeNull();
    expect(
      checkRequest(
        post({ "content-length": String(Math.ceil(MAX_BODY_BYTES) + 1) }),
      )?.status,
    ).toBe(413);
  });

  it("answers 429 with when to try again", () => {
    const now = 5 * SEND_WINDOW_MS + 60_000;
    const refused = tooMany(now);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe(
      String((SEND_WINDOW_MS - 60_000) / 1000),
    );
    expect(sendWindow(now)).toBe(5);
  });

  it("tells a send with files from one without", () => {
    expect(
      carriesFiles(
        post({
          "content-type": "multipart/form-data; boundary=x",
          "content-length": String(500 * 1024),
        }),
      ),
    ).toBe(true);
    expect(
      carriesFiles(
        post({
          "content-type": "multipart/form-data; boundary=x",
          "content-length": "300",
        }),
      ),
    ).toBe(false);
    expect(
      carriesFiles(
        post({
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(500 * 1024),
        }),
      ),
    ).toBe(false);
  });

  it("hashes an address with the salt, so a counter's name holds no address", async () => {
    const one = await addressHash("203.0.113.9", "salt-a");
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(one).not.toContain("203");
    expect(await addressHash("203.0.113.9", "salt-a")).toBe(one);
    expect(await addressHash("203.0.113.9", "salt-b")).not.toBe(one);
  });
});
