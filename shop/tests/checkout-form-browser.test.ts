import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  StripeCheckoutFormChangeEvent,
  StripeCheckoutFormConfirmEvent,
  StripeCheckoutFormValue,
} from "@stripe/stripe-js";
import { mountCheckoutForm } from "../src/browser/checkout-form.ts";

const mocks = vi.hoisted(() => ({
  listeners: new Map<
    string,
    (
      event: StripeCheckoutFormChangeEvent | StripeCheckoutFormConfirmEvent,
    ) => void | Promise<void>
  >(),
  loadStripe: vi.fn(),
  getValue: vi.fn(),
  confirm: vi.fn(),
  runServerUpdate: vi.fn(),
  fetch: vi.fn(),
  assign: vi.fn(),
  changeAppearance: vi.fn(),
  themeChanged: vi.fn(),
}));
vi.mock("@stripe/stripe-js/pure/index.js", () => ({
  loadStripe: mocks.loadStripe,
}));
const items = [{ variantId: "shirt-medium", quantity: 1 }];
const report = vi.fn();
afterEach(() => vi.unstubAllGlobals());
const value: StripeCheckoutFormValue = {
  complete: true,
  empty: false,
  value: {
    customerDetails: { email: "buyer@example.com" },
    shippingAddress: {
      name: "Test Buyer",
      address: {
        line1: "Example street",
        city: "Phoenix",
        state: "AZ",
        postal_code: "85007",
        country: "US",
      },
    },
    shippingOption: {
      id: "shr_standard",
      displayName: "Standard",
      amount: "5",
    },
    payment: { collapsed: false, type: "card" },
  },
  status: {
    customerDetails: { complete: true, empty: false },
    shippingAddress: { complete: true, empty: false },
  },
};
beforeEach(() => {
  mocks.listeners.clear();
  for (const mock of [
    mocks.loadStripe,
    mocks.getValue,
    mocks.confirm,
    mocks.runServerUpdate,
    mocks.fetch,
    mocks.assign,
    report,
    mocks.changeAppearance,
    mocks.themeChanged,
  ])
    mock.mockReset();
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("document", { documentElement: { dataset: {} } });
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mocks.themeChanged.mockImplementation(callback);
      }
      observe() {}
    },
  );
  vi.stubGlobal("location", { assign: mocks.assign });
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async () =>
    Response.json({
      clientSecret: "sandbox-secret",
      publishableKey: "pk_test_fixture",
      token: "private-token",
    }),
  );
  mocks.getValue.mockResolvedValue(structuredClone(value));
  mocks.confirm.mockResolvedValue({ type: "success" });
  mocks.runServerUpdate.mockImplementation(
    async (callback: () => Promise<{ type: "success" }>) => {
      await callback();
      return { type: "success" };
    },
  );
  mocks.loadStripe.mockResolvedValue({
    initCheckoutFormSdk: () => ({
      changeAppearance: mocks.changeAppearance,
      loadActions: async () => ({
        type: "success",
        actions: {
          confirm: mocks.confirm,
          runServerUpdate: mocks.runServerUpdate,
        },
      }),
      createForm: () => ({
        on: (
          name: string,
          handler: (
            event:
              StripeCheckoutFormChangeEvent | StripeCheckoutFormConfirmEvent,
          ) => void | Promise<void>,
        ) => mocks.listeners.set(name, handler),
        getValue: mocks.getValue,
        mount: vi.fn(),
      }),
    }),
  });
});
async function change(current = value) {
  await mocks.listeners.get("change")!({
    elementType: "checkoutForm",
    ...current,
  });
}
async function ready() {
  await mountCheckoutForm(new HTMLElement(), items, report);
  await change();
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
}
async function confirm() {
  await mocks.listeners.get("confirm")!({
    source: "checkout-form-pay-button",
    paymentMethodType: "card",
  });
}
const requests = (path: string) =>
  mocks.fetch.mock.calls
    .filter(([url]) => url === path)
    .map(([, options]) => JSON.parse(options.body));

test("an empty cart never initializes Stripe", async () => {
  await mountCheckoutForm(new HTMLElement(), [], report);
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.loadStripe).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(
    "Add at least one product to your cart.",
    true,
  );
});
test("the embedded form follows the shop theme without height animations", async () => {
  await ready();
  document.documentElement.dataset.theme = "light";
  mocks.themeChanged();
  expect(mocks.changeAppearance).toHaveBeenLastCalledWith({
    theme: "stripe",
    disableAnimations: true,
  });
  document.documentElement.dataset.theme = "dark";
  mocks.themeChanged();
  expect(mocks.changeAppearance).toHaveBeenLastCalledWith({
    theme: "night",
    disableAnimations: true,
  });
});
test("shipping and confirmation send only delivery and email, never payment data", async () => {
  await ready();
  await confirm();
  for (const path of ["/api/checkout-shipping", "/api/checkout-confirm"]) {
    expect(requests(path)[0].value).toEqual({
      shippingAddress: value.value.shippingAddress,
      customerDetails: { email: "buyer@example.com" },
    });
  }
  expect(mocks.assign).toHaveBeenCalledWith("/order#token=private-token");
});
test("payment is blocked until shipping finishes", async () => {
  mocks.runServerUpdate.mockImplementation(() => new Promise(() => {}));
  await mountCheckoutForm(new HTMLElement(), items, report);
  await change();
  await confirm();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(requests("/api/checkout-confirm")).toEqual([]);
  expect(report).toHaveBeenCalledWith(
    "Wait for a valid shipping quote before paying.",
    true,
  );
});
test("complete address edits arriving during an update are serialized and re-quoted", async () => {
  let release: (() => void) | undefined;
  mocks.runServerUpdate.mockImplementationOnce(
    async (callback: () => Promise<{ type: "success" }>) => {
      await callback();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { type: "success" };
    },
  );
  await mountCheckoutForm(new HTMLElement(), items, report);
  await change();
  await vi.waitFor(() => expect(release).toBeDefined());
  const edited = structuredClone(value);
  edited.value.shippingAddress!.address.state = "CA";
  await change(edited);
  release!();
  await vi.waitFor(() =>
    expect(requests("/api/checkout-shipping")).toHaveLength(2),
  );
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
  expect(
    requests("/api/checkout-shipping")[1].value.shippingAddress.address.state,
  ).toBe("CA");
});
test.each(["decline", "thrown confirmation"])(
  "%s resets an open checkout and allows retry",
  async (kind) => {
    await ready();
    if (kind === "decline")
      mocks.confirm.mockResolvedValueOnce({
        type: "error",
        error: { message: "Card declined." },
      });
    else mocks.confirm.mockRejectedValueOnce(new Error("Connection failed."));
    await confirm();
    expect(requests("/api/checkout-reset")).toHaveLength(1);
    expect(mocks.assign).not.toHaveBeenCalled();
    await confirm();
    expect(mocks.assign).toHaveBeenCalledWith("/order#token=private-token");
  },
);
test("ambiguous payment status goes to authoritative order reconciliation", async () => {
  await ready();
  mocks.confirm.mockRejectedValueOnce(new Error("Connection lost."));
  mocks.fetch.mockImplementation(async (path: string) =>
    path === "/api/checkout-reset"
      ? Response.json({ error: "Payment is processing." }, { status: 409 })
      : Response.json({ ready: true }),
  );
  await confirm();
  expect(report).toHaveBeenCalledWith(
    "Payment status could not be verified. Checking your order...",
    true,
  );
  expect(mocks.assign).toHaveBeenCalledWith("/order#token=private-token");
});
test("getValue failures are reported instead of escaping the event handler", async () => {
  await ready();
  mocks.getValue.mockRejectedValueOnce(new Error("Stripe disconnected."));
  await confirm();
  expect(report).toHaveBeenCalledWith("Stripe disconnected.", true);
  expect(mocks.confirm).not.toHaveBeenCalled();
});
test("cart changes prevent payment against the original cart", async () => {
  await mountCheckoutForm(new HTMLElement(), items, report, () => [
    { ...items[0], quantity: 2 },
  ]);
  await change();
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
  await confirm();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(
    "Your cart changed. Return to your cart and start checkout again.",
    true,
  );
});
test("in-place cart mutations cannot change the original checkout signature", async () => {
  const mutable = structuredClone(items);
  await mountCheckoutForm(new HTMLElement(), mutable, report, () => mutable);
  await change();
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
  mutable[0].quantity = 2;
  await confirm();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(
    "Your cart changed. Return to your cart and start checkout again.",
    true,
  );
});
test("a timed-out shipping refresh retries with a newer revision", async () => {
  mocks.runServerUpdate.mockRejectedValueOnce(new Error("Refresh timed out."));
  await mountCheckoutForm(new HTMLElement(), items, report);
  await change();
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith("Refresh timed out.", true),
  );
  await confirm();
  await vi.waitFor(() =>
    expect(requests("/api/checkout-shipping")).toHaveLength(1),
  );
  expect(requests("/api/checkout-shipping")[0].revision).toBeGreaterThan(1);
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
});
test("lost preparation acknowledgements reset the possible payment freeze before retry", async () => {
  await ready();
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path === "/api/checkout-confirm")
      throw new Error("Acknowledgement lost.");
    return Response.json({ ready: true });
  });
  await confirm();
  expect(requests("/api/checkout-reset")).toHaveLength(1);
  expect(mocks.confirm).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(requests("/api/checkout-shipping")).toHaveLength(2),
  );
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
});
test("values changing before their change event are re-quoted, never paid", async () => {
  await ready();
  const edited = structuredClone(value);
  edited.value.shippingAddress!.address.line1 = "Changed street";
  mocks.getValue.mockResolvedValue(edited);
  await confirm();
  expect(mocks.confirm).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(requests("/api/checkout-shipping")).toHaveLength(2),
  );
  expect(
    requests("/api/checkout-shipping")[1].value.shippingAddress.address.line1,
  ).toBe("Changed street");
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
});
test("a complete-status transition without changed field values still requests shipping", async () => {
  await mountCheckoutForm(new HTMLElement(), items, report);
  const incomplete = structuredClone(value);
  incomplete.status.shippingAddress!.complete = false;
  await change(incomplete);
  expect(requests("/api/checkout-shipping")).toHaveLength(0);
  await change();
  await vi.waitFor(() =>
    expect(requests("/api/checkout-shipping")).toHaveLength(1),
  );
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
});
test("address edits during server preparation reset shipping instead of confirming stale payment", async () => {
  await ready();
  const edited = structuredClone(value);
  edited.value.shippingAddress!.address.line1 = "Changed during preparation";
  mocks.getValue.mockResolvedValueOnce(value).mockResolvedValueOnce(edited);
  await confirm();
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(requests("/api/checkout-reset")).toHaveLength(1);
  expect(report).toHaveBeenCalledWith(
    "Your checkout changed before payment. Please retry.",
    true,
  );
  await vi.waitFor(() =>
    expect(report).toHaveBeenLastCalledWith(
      "Shipping is ready. Choose a service and pay securely below.",
    ),
  );
});
