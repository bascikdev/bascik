/**
 * The hyphenated names that WHATWG HTML excludes from valid custom element
 * names ("valid custom element name", §4.13.3) because SVG and MathML already
 * define elements with them. A tag with one of these names is an SVG or
 * MathML element, never a missing component, so the "no matching component
 * file" diagnostics leave it out.
 */
export const RESERVED_CUSTOM_ELEMENT_NAMES: ReadonlySet<string> = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-src",
  "font-face-uri",
  "font-face-format",
  "font-face-name",
  "missing-glyph",
]);

/** Whether `tagName` (any case) is one of {@link RESERVED_CUSTOM_ELEMENT_NAMES}. */
export const isReservedCustomElementName = (tagName: string): boolean =>
  RESERVED_CUSTOM_ELEMENT_NAMES.has(tagName.toLowerCase());
