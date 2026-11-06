const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function imageColor(
  source: string,
  variants: { color: string; id: string }[],
  variantIds: (number | string)[],
) {
  const colors = [...new Set(variants.map((variant) => variant.color))];
  const explicit = [
    ...new Set(
      variants
        .filter((variant) => variantIds.map(String).includes(variant.id))
        .map((variant) => variant.color),
    ),
  ];
  const filename = `-${slug(decodeURIComponent(new URL(source).pathname.split("/").pop() ?? ""))}-`;
  const named = colors.filter((color) => filename.includes(`-${slug(color)}-`));
  if (
    explicit.length > 1 ||
    named.length !== 1 ||
    (explicit.length && explicit[0] !== named[0])
  )
    throw new Error(`Cannot determine a unique image color for ${source}`);
  return named[0];
}
