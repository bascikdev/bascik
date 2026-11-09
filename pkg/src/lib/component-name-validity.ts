/**
 * Component names no tag can spell (finding 144). A component's tag is its
 * file name, so `my widget.html` names `<my widget>`, which the HTML
 * tokenizer reads as `<my>` with a `widget` attribute: no usage can match it.
 * The hyphen and native-element advice in `listComponents` is separate; this
 * only checks the characters, per the WHATWG valid custom element name
 * grammar (https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name),
 * on the lowercased name.
 */

// PCENChar from the WHATWG grammar, without the uppercase letters a
// lowercased name cannot hold.
const PCEN_CHAR =
  "\\-.0-9_a-z\\u00B7\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u203F-\\u2040\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const VALID_NAME_CHARS = new RegExp(`^[a-z][${PCEN_CHAR}]*$`, "u");
// nosemgrep javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
const INVALID_RUN = new RegExp(`[^${PCEN_CHAR}]+`, "gu");

/**
 * A name a tag can spell, from one it cannot: each run of characters a
 * custom element name cannot hold becomes `-`, and a name that still does
 * not start with a letter or has no hyphen gets the `my-` prefix
 * (`my widget` -> `my-widget`, `2col` -> `my-2col`).
 */
export const suggestValidComponentName = (name: string): string => {
  const dashed = name
    .toLowerCase()
    .replace(INVALID_RUN, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (dashed === "") return "my-component";
  return /^[a-z]/.test(dashed) && dashed.includes("-")
    ? dashed
    : `my-${dashed}`;
};

/**
 * The warning for a component whose name no tag can spell, naming the file
 * and a name to rename it to, or undefined for a name a tag can spell.
 */
export const invalidComponentNameMessage = (
  name: string,
  filePath: string,
): string | undefined => {
  if (VALID_NAME_CHARS.test(name)) return undefined;
  return (
    `warning: Component file "${filePath.replace(/\\/g, "/")}" names the tag <${name}>, ` +
    `which no HTML tag can spell, so no page can use it. A component name must start with ` +
    `a lowercase ASCII letter and hold only letters, digits, "-", ".", and "_" ` +
    `(WHATWG HTML §4.13.3). Rename the file to "${suggestValidComponentName(name)}.html".`
  );
};
