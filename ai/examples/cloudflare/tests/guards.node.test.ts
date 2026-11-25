import { describe, expect, it } from "vitest";
import {
  MAX_BODY_BYTES,
  SEND_WINDOW_MS,
  addressHash,
  addressKey,
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

  it("reads the multipart media type in any case, as formData() does", () => {
    for (const type of [
      "Multipart/Form-Data; boundary=x",
      "MULTIPART/FORM-DATA; boundary=x",
      " multipart/form-data;boundary=x",
    ]) {
      expect(
        carriesFiles(
          post({ "content-type": type, "content-length": String(40 * 1024) }),
        ),
        type,
      ).toBe(true);
    }
  });

  it("keys an IPv4 address whole and an IPv6 address by its /64", () => {
    expect(addressKey("203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("203.0.113.10")).not.toBe(addressKey("203.0.113.9"));
    // Two addresses in one /64: one client.
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(
      "2001:db8:1:2::/64",
    );
    expect(addressKey("2001:0DB8:0001:0002:0:0:0:9")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(addressKey("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    // An IPv4 address written as IPv6 is that IPv4 address.
    expect(addressKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(addressKey("::ffff:cb00:7109")).toBe("203.0.113.9");
    // Not an address: used as it is.
    expect(addressKey("unknown")).toBe("unknown");
    expect(addressKey("1:2:3")).toBe("1:2:3");
    expect(addressKey("1::2::3")).toBe("1::2::3");
  });

  it("hashes two addresses of one IPv6 /64 the same, and another /64 apart", async () => {
    const one = await addressHash("2001:db8:1:2::1", "salt");
    expect(await addressHash("2001:db8:1:2:ffff::7", "salt")).toBe(one);
    expect(await addressHash("2001:db8:1:3::1", "salt")).not.toBe(one);
  });

  it("hashes an address with the salt, so a counter's name holds no address", async () => {
    const one = await addressHash("203.0.113.9", "salt-a");
    expect(one).toMatch(/^[0-9a-f]{32}$/);
    expect(one).not.toContain("203");
    expect(await addressHash("203.0.113.9", "salt-a")).toBe(one);
    expect(await addressHash("203.0.113.9", "salt-b")).not.toBe(one);
  });
});
