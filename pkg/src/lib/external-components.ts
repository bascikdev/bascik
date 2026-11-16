import { isReservedCustomElementName } from "./reserved-element-names.ts";
import { compilePreservedTags } from "./shielding.ts";

/**
 * Build a predicate for `components.external`: hyphenated tags owned by a
 * browser custom element or a third-party library rather than a Bascik
 * component file. Entries are exact tag names or `*` wildcard patterns and use
 * the same matching rules as `scoping.preserve` (case-insensitive, `*` matches
 * any run of tag-name characters).
 *
 * This only suppresses the "no matching component file" diagnostics. It never
 * changes component resolution: a real component with the same name still
 * expands, and scoping is unaffected (use `scoping.preserve` for that).
 *
 * The SVG and MathML element names that HTML reserves (`font-face`,
 * `annotation-xml`, ...) always match: they are never missing components.
 */
export const createExternalTagMatcher = (
  entries: readonly string[] | undefined,
): ((tagName: string) => boolean) => {
  const valid = (entries ?? []).filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  if (valid.length === 0) return isReservedCustomElementName;
  const compiled = compilePreservedTags(valid);
  return (tagName) => {
    const tag = tagName.toLowerCase();
    return (
      isReservedCustomElementName(tag) ||
      compiled.exact.has(tag) ||
      compiled.patterns.some((pattern) => pattern.test(tag))
    );
  };
};
