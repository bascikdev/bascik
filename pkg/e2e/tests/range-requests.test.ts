/**
 * Audit 159 finding 34: the Bascik server answers a single byte range on a
 * static file, so audio and video can seek and Safari, which needs byte
 * ranges for media, plays them. Runs in the prod HTTP/1.1 and HTTP/2 lanes
 * (and dev, which shares the handler); the static harness has no ranges.
 */
import { test, expect } from "@playwright/test";

const ASSET = "/static-asset-test.css";

test.describe("byte ranges on static files", () => {
  test("a whole file advertises Accept-Ranges", async ({ request }) => {
    const res = await request.get(ASSET);
    expect(res.status()).toBe(200);
    expect(res.headers()["accept-ranges"]).toBe("bytes");
  });

  test("a single range gets 206 with Content-Range and exactly those bytes", async ({
    request,
  }) => {
    const whole = await request.get(ASSET, {
      headers: { "Accept-Encoding": "identity" },
    });
    const bytes = await whole.body();

    const res = await request.get(ASSET, {
      headers: { Range: "bytes=2-11", "Accept-Encoding": "gzip, br" },
    });
    expect(res.status()).toBe(206);
    expect(res.headers()["content-range"]).toBe(
      `bytes 2-11/${bytes.byteLength}`,
    );
    expect(res.headers()["content-encoding"]).toBeUndefined();
    expect((await res.body()).equals(bytes.subarray(2, 12))).toBe(true);
  });

  test("a suffix range gets the last bytes", async ({ request }) => {
    const bytes = await (
      await request.get(ASSET, { headers: { "Accept-Encoding": "identity" } })
    ).body();
    const res = await request.get(ASSET, { headers: { Range: "bytes=-5" } });
    expect(res.status()).toBe(206);
    expect((await res.body()).equals(bytes.subarray(-5))).toBe(true);
  });

  test("a range past the end gets 416 with the file size", async ({
    request,
  }) => {
    const bytes = await (
      await request.get(ASSET, { headers: { "Accept-Encoding": "identity" } })
    ).body();
    const res = await request.get(ASSET, {
      headers: { Range: `bytes=${bytes.byteLength}-` },
    });
    expect(res.status()).toBe(416);
    expect(res.headers()["content-range"]).toBe(`bytes */${bytes.byteLength}`);
  });
});
