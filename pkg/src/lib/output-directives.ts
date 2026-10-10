/**
 * Directive scripts printed by a build script.
 *
 * Build script output is transpiled again so it can contain component tags and
 * plain client scripts. Directive scripts are different: a printed
 * `<script data-bascik-build>` would run at build time and a printed
 * `<script data-bascik-server>` would be registered as request-time code. Build
 * scripts routinely print HTML they did not write (a CMS post body, an API
 * response), so a directive inside that data would execute with the build's
 * privileges. Directives are therefore only honored where an author wrote them
 * in a source file; printed ones are removed before any later pass sees them.
 */
import { ATTR, ANY_DIRECTIVE_ATTR_NAME, ATTR_NAME_END, SCRIPT_END_TAG, SCRIPT_TAG_PREFIX } from "./html-patterns.ts";

// A `<script>` open tag carrying any directive attribute, with its body and closing tag when
// present. Without a closing tag the open tag alone is removed, so a later pass can never pair it
// with an unrelated `</script>`.
const DIRECTIVE_SCRIPT_RE = new RegExp(
  `${SCRIPT_TAG_PREFIX}(?:\\s+${ATTR})*?\\s+(${ANY_DIRECTIVE_ATTR_NAME.replace(ATTR_NAME_END, "")})${ATTR_NAME_END}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?(?:\\s+${ATTR})*\\s*\\/?>(?:[\\s\\S]*?${SCRIPT_END_TAG})?`,
  "gi",
);

export interface RemovedDirectives {
  html: string;
  /** Directive attribute names found, in order of first appearance (`data-bascik-build`, ...). */
  removed: string[];
}

/** Remove every directive `<script>` from build script output. */
export const removeOutputDirectives = (html: string): RemovedDirectives => {
  const removed = new Set<string>();
  const cleaned = html.replace(DIRECTIVE_SCRIPT_RE, (_tag, name: string) => {
    removed.add(name.toLowerCase());
    return "";
  });
  return removed.size === 0 ? { html, removed: [] } : { html: cleaned, removed: [...removed] };
};
