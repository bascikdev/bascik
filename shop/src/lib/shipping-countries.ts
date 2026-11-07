import countries from "../../catalog/countries.json" with { type: "json" };
import destinations from "../../catalog/shipping-countries.json" with { type: "json" };

const supported: Record<string, string[]> = destinations;
export function shippingCountries(productIds: string[]) {
  const ids = productIds.length
    ? [...new Set(productIds)]
    : Object.keys(supported);
  for (const id of ids)
    if (!supported[id])
      throw new Error(`Shipping countries missing for product ${id}`);
  return countries
    .filter((country) =>
      ids.every((id) => supported[id].includes(country.code)),
    )
    .sort((a, b) => {
      if (a.code === "US") return -1;
      if (b.code === "US") return 1;
      return a.name.localeCompare(b.name, "en");
    });
}
