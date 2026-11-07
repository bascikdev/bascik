import { money } from "./catalog.ts";
import countries from "../../catalog/countries.json" with { type: "json" };

export const freeShippingThreshold = 5000;
export const freeShippingOffer =
  "Free standard shipping on merchandise orders over $50 to the lower 48 states.";
export const freeShippingDetails =
  "Before tax and shipping. The lowest-cost available shipping option is free; other services retain their full price. Excludes Alaska, Hawaii, territories, and military addresses.";

const lower48 = new Set(
  "AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(
    " ",
  ),
);

export function isLower48(country: string, state: string) {
  if (country.trim().toUpperCase() !== "US") return false;
  const input = state.trim().toUpperCase();
  const code = countries
    .find((region) => region.code === "US")
    ?.states?.find(
      (region) =>
        region.code.toUpperCase() === input ||
        region.name.toUpperCase() === input,
    )?.code;
  return code !== undefined && lower48.has(code);
}

export function qualifiesForFreeShipping(
  subtotal: number,
  country: string,
  state: string,
) {
  return subtotal > freeShippingThreshold && isLower48(country, state);
}

export function freeShippingProgress(
  subtotal: number,
  destination?: { country: string; state: string },
) {
  if (subtotal > freeShippingThreshold) {
    if (destination?.country && destination.state) {
      return isLower48(destination.country, destination.state)
        ? "Your cart qualifies for free standard shipping to this state. Confirm availability with a shipping quote."
        : "This destination is outside the lower 48 states. Regular shipping rates apply.";
    }
    if (destination?.country && destination.country !== "US")
      return "This destination is outside the lower 48 states. Regular shipping rates apply.";
    return "Your cart qualifies for free standard shipping to the lower 48 states. Eligibility is confirmed with your delivery address.";
  }
  if (subtotal === freeShippingThreshold)
    return "Add another item to unlock free standard shipping to the lower 48 states. Merchandise must total over $50.";
  return `Add more than ${money(freeShippingThreshold - subtotal)} in merchandise to unlock free standard shipping to the lower 48 states.`;
}
