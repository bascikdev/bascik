import { expect, test } from "vitest";
import { updateCheckoutNotice } from "../scripts/checkout-notice.ts";
import { prelaunchNotice } from "../src/components/checkout-header/notice.ts";

const notice = `<p class="scoped-notice" data-testid="checkout-prelaunch">${prelaunchNotice}</p>`;

test("launch removes only the prelaunch notice from formatted output", () => {
  const formatted = notice.replace(" tax, fulfillment", " tax,\n  fulfillment");
  expect(
    updateCheckoutNotice(`<main>${formatted}<p>Other notice</p></main>`),
  ).toBe("<main><p>Other notice</p></main>");
});

test("preview replaces the notice while preserving scoped attributes", () => {
  const replacement = "Sandbox preview: use test details only.";
  expect(updateCheckoutNotice(notice, replacement)).toBe(
    `<p class="scoped-notice" data-testid="checkout-prelaunch">${replacement}</p>`,
  );
  expect(updateCheckoutNotice(notice, "<script>&$&")).toContain(
    "&lt;script&gt;&amp;$&",
  );
});

test.each([
  "<p>Other notice</p>",
  notice + notice,
  notice.replace(prelaunchNotice, "Unexpected text"),
])(
  "packaging refuses missing, duplicate, or changed prelaunch notices",
  (page) => {
    expect(() => updateCheckoutNotice(page)).toThrow(
      "Expected exactly one unchanged checkout prelaunch notice.",
    );
  },
);
