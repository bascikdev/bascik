import { esc } from "@bascik/bascik/html";
import { prelaunchNotice } from "../src/components/checkout-header/notice.ts";

export function updateCheckoutNotice(page: string, replacement?: string) {
  const pattern =
    /(<p\b[^>]*\bdata-testid="checkout-prelaunch"[^>]*>)([\s\S]*?)(<\/p>)/g;
  const matches = [...page.matchAll(pattern)];
  if (
    matches.length !== 1 ||
    matches[0][2].trim().replace(/\s+/g, " ") !== prelaunchNotice
  )
    throw new Error(
      "Expected exactly one unchanged checkout prelaunch notice.",
    );
  return page.replace(
    pattern,
    (_match, open: string, _text: string, close: string) =>
      replacement === undefined ? "" : `${open}${esc(replacement)}${close}`,
  );
}
