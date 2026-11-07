import { expect, test } from "vitest";
import countries from "../catalog/countries.json" with { type: "json" };
import {
  isLower48,
  qualifiesForFreeShipping,
  freeShippingProgress,
} from "../src/lib/free-shipping.ts";

test.each([
  [0, false],
  [4999, false],
  [5000, false],
  [5001, true],
  [5500, true],
])("merchandise subtotal %i has eligibility %s", (subtotal, eligible) => {
  expect(qualifiesForFreeShipping(subtotal, "US", "CA")).toBe(eligible);
});

test("exactly the lower 48 states qualify, by code or full name", () => {
  const states = countries.find((country) => country.code === "US")!.states!;
  const eligible = states.filter((state) => isLower48("US", state.code));
  expect(eligible).toHaveLength(48);
  for (const state of eligible)
    expect(
      qualifiesForFreeShipping(6000, " us ", state.name.toLowerCase()),
    ).toBe(true);
});

test.each([
  ["US", "AK"],
  ["US", "Alaska"],
  ["US", "HI"],
  ["US", "Hawaii"],
  ["US", "DC"],
  ["US", "PR"],
  ["US", "GU"],
  ["US", "VI"],
  ["US", "AS"],
  ["US", "MP"],
  ["US", "AA"],
  ["US", "AE"],
  ["US", "AP"],
  ["US", ""],
  ["US", "invalid"],
  ["CA", "CA"],
  ["AU", "WA"],
  ["PR", "CA"],
])("%s/%s never qualifies regardless of cart size", (country, state) => {
  expect(qualifiesForFreeShipping(100000, country, state)).toBe(false);
});

test("progress distinguishes the exact threshold, address-dependent qualification, and exclusions", () => {
  expect(freeShippingProgress(3000)).toContain("more than $20.00");
  expect(freeShippingProgress(5000)).toContain("Add another item");
  expect(freeShippingProgress(5001)).toContain(
    "Eligibility is confirmed with your delivery address",
  );
  expect(
    freeShippingProgress(6000, { country: "US", state: "California" }),
  ).toContain("qualifies");
  expect(freeShippingProgress(6000, { country: "US", state: "HI" })).toContain(
    "Regular shipping rates apply",
  );
  expect(freeShippingProgress(6000, { country: "CA", state: "" })).toContain(
    "Regular shipping rates apply",
  );
});
