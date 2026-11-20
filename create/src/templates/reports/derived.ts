/**
 * @module templates/reports/derived
 *
 * The pieces the `reports` template takes from the default template instead of
 * copying them: the skip link's styles and the shared head tags.
 */

import { SITE_HEADER_CSS, SITE_META_HTML } from "../../scaffold.js";

/**
 * The default header's skip link rules, exactly as written there: hidden by
 * clipping until focused. They are the first two rules of `SITE_HEADER_CSS`,
 * up to its `header` rule.
 */
export const SKIP_LINK_CSS = SITE_HEADER_CSS.slice(
  0,
  SITE_HEADER_CSS.indexOf("\nheader {"),
);

/**
 * The default head component (charset, viewport, the favicons `scaffold` writes
 * for every template) without its fixed description or external CSS link:
 * each page writes metadata, and assets.inlineStyles injects global CSS.
 */
export const SITE_META_HTML_WITHOUT_DESCRIPTION =
  SITE_META_HTML.split("\n")
    .filter(
      (line) =>
        !line.includes('name="description"') &&
        !line.includes('rel="stylesheet"'),
    )
    .join("\n") +
  `
<script type="text/typescript">
  try {
    const saved = localStorage.getItem("bascik-reports-theme");
    if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  } catch { /* System preference remains the fallback when storage is blocked. */ }
</script>
`;
