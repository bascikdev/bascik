import { html, json, type SafeHtml } from "@bascik/bascik/html";

/** Render structured data with the package helpers that protect JSON script content. */
export function renderJsonLd(...schemas: unknown[]): SafeHtml {
  return html`${schemas.map(
    (schema) =>
      html`<script type="application/ld+json">
        ${json(schema)}
      </script>`,
  )}`;
}
