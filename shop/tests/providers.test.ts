import { afterEach, expect, test, vi } from "vitest";
import { placements, shippingPlacements } from "../src/lib/printful-design.ts";
import { printful, printfulList } from "../src/lib/providers.ts";
import type { Env } from "../src/lib/platform.ts";
import { handler, ProviderError } from "../src/lib/platform.ts";
import { createHmac } from "node:crypto";
import { verifyPrintfulSignature } from "../src/lib/webhooks.ts";

const env = {
  PRINTFUL_TOKEN: "fixture",
  PRINTFUL_STORE_ID: "123",
} satisfies Pick<Env, "PRINTFUL_TOKEN" | "PRINTFUL_STORE_ID">;
afterEach(() => vi.restoreAllMocks());
test.each([400, 422, 429, 500])(
  "shipping provider HTTP %s is logged safely and invalid addresses are actionable",
  async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        { error: "Private provider response should not be logged" },
        { status },
      ),
    );
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await handler(async () => {
      await printful(env, "/shipping-rates", {});
      return new Response();
    })(
      new Request("https://shop.example.com/api/quote", {
        headers: { "cf-ray": "fixture-ray" },
      }),
      { platform: { env: { DB: {} } } },
    );
    expect(response.status).toBe([400, 422].includes(status) ? 422 : 502);
    expect(logger).toHaveBeenCalledWith("Shop request failed", {
      path: "/api/quote",
      requestId: "fixture-ray",
      type: "ProviderError",
      provider: "Printful",
      providerStatus: status,
      providerPath: "/shipping-rates",
      retryAt: 0,
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("Private provider");
    const payload = await response.json();
    if ([400, 422].includes(status))
      expect(payload.error).toContain("Check your state/province");
    else expect(payload.error).toContain("Please try again");
  },
);
test("provider diagnostics exclude URL queries and do not expose credentials", () => {
  expect(
    new ProviderError("Printful", 400, null, "/shipping-rates?secret=test")
      .path,
  ).toBe("/shipping-rates");
});
test("v2 HTTP requests use the data envelope and store header", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ data: { id: 1 } }));
  await expect(printful(env, "/orders", { order_items: [] })).resolves.toEqual({
    id: 1,
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.printful.com/v2/orders",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "X-PF-Store-Id": "123" }),
    }),
  );
});
test("a legacy response envelope fails explicitly", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ result: {} }),
  );
  await expect(printful(env, "/orders/@fixture")).rejects.toThrow(
    "Printful response",
  );
});
test.each(["test", undefined] as const)(
  "Printful confirmation is forbidden in %s mode before any network call",
  async (SHOP_MODE) => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    await expect(
      printful({ ...env, SHOP_MODE }, "/orders/123/confirmation", {}),
    ).rejects.toThrow("forbidden");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
test("v2 shipment pagination follows the returned page size", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: 1 }],
        paging: { total: 2, offset: 0, limit: 1 },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: [{ id: 2 }],
        paging: { total: 2, offset: 1, limit: 1 },
      }),
    );
  await expect(printfulList(env, "/orders/10/shipments")).resolves.toEqual([
    { id: 1 },
    { id: 2 },
  ]);
  expect(String(fetcher.mock.calls[1][0])).toContain("offset=1");
});
test("incomplete shipment pagination fails rather than losing tracking", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ data: [], paging: { total: 1, offset: 0, limit: 100 } }),
  );
  await expect(printfulList(env, "/orders/10/shipments")).rejects.toThrow(
    "pagination",
  );
});
test("artwork mappings cannot silently center designs or use legacy sync IDs", () => {
  expect(() => placements(undefined)).toThrow("verification");
  expect(() =>
    placements([
      {
        placement: "front",
        technique: "dtg",
        layers: [{ type: "file", url: "https://example.com/art.png" }],
      },
    ]),
  ).toThrow("placement");
  expect(() => placements([{ sync_variant_id: 123 }])).toThrow("placement");
});
test("template shipping preserves DTF hat and outside-label techniques without recreating artwork", () => {
  const design = [
    { placement: "front_dtf_hat", technique: "dtfilm" },
    { placement: "label_outside", technique: "dtg" },
  ];
  expect(shippingPlacements(design)).toEqual(design);
  expect(() =>
    shippingPlacements([{ placement: "front", technique: "DTFILM" }]),
  ).toThrow("shipping placement");
  expect(() => shippingPlacements([])).toThrow("shipping placement");
});
test("explicit artwork positioning and embroidery thread options are preserved", () => {
  const design = [
    {
      placement: "front",
      technique: "embroidery",
      layers: [
        {
          type: "file",
          url: "https://example.com/art.png",
          position: { width: 2, height: 1, left: 1, top: 1 },
          layer_options: [{ name: "thread_colors", value: ["#FFFFFF"] }],
        },
      ],
    },
  ];
  expect(placements(design)).toEqual(design);
});
test.each([
  { technique: ["dtg"] },
  { technique: null },
  { technique: 123 },
  { technique: {} },
  { technique: true },
])("Printful placements reject non-string technique %j", ({ technique }) => {
  const placement = {
    placement: "front",
    technique,
    layers: [
      {
        type: "file",
        url: "https://example.com/art.png",
        position: { width: 2, height: 1, left: 1, top: 1 },
      },
    ],
  };
  expect(() => placements([placement])).toThrow("artwork placement");
  expect(() => shippingPlacements([placement])).toThrow("shipping placement");
});
test("v2 signatures decode the hexadecimal secret and cover raw JSON bytes", async () => {
  const secret = "ab".repeat(32);
  const payload = '{"type": "shipment_sent"}';
  const signature = createHmac("sha256", Buffer.from(secret, "hex"))
    .update(payload)
    .digest("hex");
  await expect(
    verifyPrintfulSignature(secret, payload, signature),
  ).resolves.toBeUndefined();
  await expect(
    verifyPrintfulSignature(secret, '{"type":"shipment_sent"}', signature),
  ).rejects.toThrow("signature");
  const incorrect = createHmac("sha256", secret).update(payload).digest("hex");
  await expect(
    verifyPrintfulSignature(secret, payload, incorrect),
  ).rejects.toThrow("signature");
  await expect(verifyPrintfulSignature(secret, payload, "")).rejects.toThrow(
    "signature",
  );
});
