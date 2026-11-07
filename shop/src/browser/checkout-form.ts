import { loadStripe } from "@stripe/stripe-js/pure/index.js";
import type {
  StripeCheckoutFormValue,
  StripeCheckoutFormLoadActionsSuccess,
} from "@stripe/stripe-js";

export async function mountCheckoutForm(
  container: HTMLElement,
  items: { variantId: string; quantity: number }[],
  report: (message: string, error?: boolean) => void,
  currentItems = () => items,
) {
  async function api(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error ?? "Secure checkout failed. Please try again.",
      );
    return result;
  }
  if (!items.length) {
    report("Add at least one product to your cart.", true);
    return;
  }
  const cartKey = JSON.stringify(items);
  const session = await api("/api/checkout-form", { items });
  const stripe = await loadStripe(session.publishableKey);
  if (!stripe)
    throw new Error("Stripe could not load. Check your connection and reload.");
  const appearance = () => ({
    theme:
      document.documentElement.dataset.theme === "light"
        ? ("stripe" as const)
        : ("night" as const),
    disableAnimations: true,
  });
  const checkout = stripe.initCheckoutFormSdk({
    clientSecret: session.clientSecret,
    appearance: appearance(),
  });
  new MutationObserver(() => checkout.changeAppearance(appearance())).observe(
    document.documentElement,
    { attributes: true, attributeFilter: ["data-theme"] },
  );
  const loaded = await checkout.loadActions();
  if (loaded.type !== "success") throw new Error(loaded.error.message);
  const actions: StripeCheckoutFormLoadActionsSuccess = loaded.actions;
  const form = checkout.createForm({
    expressCheckout: {
      paymentMethods: {
        applePay: "never",
        googlePay: "never",
        link: "never",
        paypal: "never",
        amazonPay: "never",
        klarna: "never",
      },
    },
  });
  let latest: StripeCheckoutFormValue | undefined;
  let fingerprint = "";
  let revision = 0;
  let accepted = 0;
  let processing = false;
  let confirming = false;
  const details = (value: StripeCheckoutFormValue) => ({
    shippingAddress: value.value.shippingAddress,
    customerDetails: { email: value.value.customerDetails.email },
  });
  const key = (value: StripeCheckoutFormValue) =>
    JSON.stringify(details(value));
  const completeAddress = (value: StripeCheckoutFormValue) =>
    value.status.shippingAddress?.complete &&
    value.status.customerDetails.complete;
  async function updateShipping() {
    if (processing || confirming) return;
    processing = true;
    try {
      while (latest && completeAddress(latest) && accepted !== revision) {
        const current = latest;
        const version = revision;
        report("Calculating Printful shipping...");
        const update = await actions.runServerUpdate(async () => {
          await api("/api/checkout-shipping", {
            token: session.token,
            revision: version,
            value: details(current),
          });
          return { type: "success" as const };
        });
        if (update.type === "error") throw new Error(update.error.message);
        accepted = version;
        if (revision === version)
          report("Shipping is ready. Choose a service and pay securely below.");
      }
    } catch (error) {
      accepted = 0;
      revision++;
      report(
        error instanceof Error ? error.message : "Shipping calculation failed.",
        true,
      );
    } finally {
      processing = false;
    }
  }
  form.on("change", (event) => {
    latest = event;
    const next = key(event);
    if (next !== fingerprint) {
      fingerprint = next;
      revision++;
      accepted = 0;
      if (!completeAddress(event))
        report("Complete your contact and delivery details in Stripe.");
    }
    if (completeAddress(event) && accepted !== revision) void updateShipping();
  });
  form.on("confirm", async (event) => {
    if (confirming) return;
    confirming = true;
    let preparationAttempted = false;
    try {
      if (JSON.stringify(currentItems()) !== cartKey)
        throw new Error(
          "Your cart changed. Return to your cart and start checkout again.",
        );
      const current = await form.getValue();
      if (key(current) !== fingerprint) {
        latest = current;
        fingerprint = key(current);
        revision++;
        accepted = 0;
      }
      if (
        !current.complete ||
        !completeAddress(current) ||
        processing ||
        accepted !== revision
      ) {
        latest = current;
        throw new Error("Wait for a valid shipping quote before paying.");
      }
      preparationAttempted = true;
      try {
        await api("/api/checkout-confirm", {
          token: session.token,
          revision: accepted,
          value: details(current),
          shippingRateId: current.value.shippingOption?.id,
        });
      } catch (error) {
        accepted = 0;
        revision++;
        throw error;
      }
      const beforePayment = await form.getValue();
      if (key(beforePayment) !== fingerprint) {
        latest = beforePayment;
        fingerprint = key(beforePayment);
        revision++;
        accepted = 0;
      }
      if (
        !beforePayment.complete ||
        accepted !== revision ||
        key(beforePayment) !== key(current) ||
        beforePayment.value.shippingOption?.id !==
          current.value.shippingOption?.id ||
        JSON.stringify(currentItems()) !== cartKey
      )
        throw new Error("Your checkout changed before payment. Please retry.");
      const result = await actions.confirm({
        formConfirmEvent: event,
        redirect: "if_required",
      });
      if (result.type === "error") throw new Error(result.error.message);
      location.assign(`/order#token=${encodeURIComponent(session.token)}`);
    } catch (error) {
      if (preparationAttempted) {
        try {
          await api("/api/checkout-reset", { token: session.token });
        } catch {
          report(
            "Payment status could not be verified. Checking your order...",
            true,
          );
          location.assign(`/order#token=${encodeURIComponent(session.token)}`);
          return;
        }
      }
      report(
        error instanceof Error ? error.message : "Payment could not complete.",
        true,
      );
    } finally {
      confirming = false;
      if (latest && accepted !== revision) void updateShipping();
    }
  });
  form.on("loaderror", (event) =>
    report(event.error.message ?? "Stripe could not load.", true),
  );
  form.on("ready", () =>
    report("Enter your contact and delivery details in Stripe."),
  );
  form.mount(container);
}
