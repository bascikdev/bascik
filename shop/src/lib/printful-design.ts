import { ShopError } from "./platform.ts";

export interface PrintfulOption {
  name: string;
  value: string | boolean | string[];
}
export interface PrintfulShippingPlacement {
  placement: string;
  technique: string;
  placement_options?: PrintfulOption[];
}
export interface PrintfulPlacement {
  placement: string;
  technique: string;
  placement_options?: PrintfulOption[];
  layers: {
    type: "file";
    url: string;
    position: { width: number; height: number; top: number; left: number };
    layer_options?: PrintfulOption[];
  }[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function options(value: unknown) {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (entry) =>
          record(entry) &&
          typeof entry.name === "string" &&
          (typeof entry.value === "string" ||
            typeof entry.value === "boolean" ||
            (Array.isArray(entry.value) &&
              entry.value.every((item) => typeof item === "string"))),
      ))
  );
}
function validLayer(
  value: unknown,
): value is PrintfulPlacement["layers"][number] {
  if (
    !record(value) ||
    value.type !== "file" ||
    typeof value.url !== "string" ||
    !URL.canParse(value.url) ||
    new URL(value.url).protocol !== "https:" ||
    !record(value.position) ||
    !options(value.layer_options)
  )
    return false;
  const position = value.position;
  return (
    ["width", "height", "top", "left"].every(
      (key) =>
        typeof position[key] === "number" && Number.isFinite(position[key]),
    ) &&
    Number(position.width) >= 0.3 &&
    Number(position.height) >= 0.3
  );
}
function validPlacement(value: unknown): value is PrintfulPlacement {
  return (
    record(value) &&
    typeof value.placement === "string" &&
    Boolean(value.placement) &&
    typeof value.technique === "string" &&
    [
      "dtg",
      "digital",
      "cut-sew",
      "uv",
      "embroidery",
      "sublimation",
      "dtfilm",
    ].includes(value.technique) &&
    options(value.placement_options) &&
    Array.isArray(value.layers) &&
    value.layers.length > 0 &&
    value.layers.every(validLayer)
  );
}
export function shippingPlacements(
  value: unknown,
): PrintfulShippingPlacement[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 10 ||
    !value.every(
      (entry): entry is PrintfulShippingPlacement =>
        record(entry) &&
        typeof entry.placement === "string" &&
        Boolean(entry.placement) &&
        typeof entry.technique === "string" &&
        [
          "dtg",
          "digital",
          "cut-sew",
          "uv",
          "embroidery",
          "sublimation",
          "dtfilm",
        ].includes(entry.technique) &&
        options(entry.placement_options),
    )
  )
    throw new ShopError("Invalid Printful template shipping placement.", 503);
  return value;
}
export function placements(value: unknown): PrintfulPlacement[] {
  if (!Array.isArray(value) || !value.length || value.length > 10)
    throw new ShopError(
      "Printful v2 artwork mappings require verification.",
      503,
    );
  if (!value.every(validPlacement))
    throw new ShopError("Invalid Printful v2 artwork placement.", 503);
  return value;
}
