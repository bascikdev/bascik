/**
 * html-entities.ts: the docs build's one entity decoder, for the text it
 * reads back out of HTML: a page shell's <title> and description
 * (meta-tags.ts) and a rendered heading (heading-slug.ts).
 *
 * It decodes the spellings page shells and marked write for the five
 * characters HTML escapes, exactly as the browser does: names are
 * case-sensitive (`&AMP;` is `&`; `&Amp;` is no reference, and `&Lt;` is
 * HTML's ≪, so neither may become `<` or `&`). Any other reference stays as
 * written, so meta-tags.test.ts's page-shell guard can see it; pkg's
 * decoder (pkg/src/lib/character-references.ts) is the full one, and the
 * tests check this table against it and against parse5.
 */

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&AMP;": "&",
  "&lt;": "<",
  "&LT;": "<",
  "&gt;": ">",
  "&GT;": ">",
  "&quot;": '"',
  "&QUOT;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&#X27;": "'",
};

/** Every spelling decodeHtmlText decodes. */
export const DECODED_ENTITIES: readonly string[] = Object.keys(ENTITIES);

const ENTITY = /&(?:amp|AMP|lt|LT|gt|GT|quot|QUOT|apos|#39|#[xX]27);/g;

/** Decodes the table's entities in one pass, so `&amp;lt;` reads as `&lt;`, not `<`. */
export function decodeHtmlText(value: string): string {
  return value.replace(ENTITY, (entity) => ENTITIES[entity]);
}
