/**
 * What is sent back: a stored file as a locked-down response, and the page
 * a browser with no script sees when a send was refused.
 */
import { html } from "@bascik/bascik/html";
import { DEFAULT_FILE_TYPES } from "./limits.ts";
import { isImageType, isTextType, storedName } from "./names.ts";
import type { StoredFile } from "./types.ts";

/** A name safe to put in a `Content-Disposition` header, in two forms. */
function dispositionName(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%;]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/**
 * A stored file as a response. Whatever the bytes are, they are shown as
 * only what they were checked to be (`nosniff`), only to the reader they
 * belong to (the caller looked it up for them), under a name that ends in
 * that type's extension (`storedName`), and with a policy that lets the
 * response do nothing if it is ever opened as a page. Images are shown
 * in the page; everything else is a download.
 */
export function fileResponse(file: StoredFile): Response {
  const known = DEFAULT_FILE_TYPES.includes(file.mediaType);
  const type = known
    ? isTextType(file.mediaType)
      ? `${file.mediaType}; charset=utf-8`
      : file.mediaType
    : "application/octet-stream";
  const inline = known && isImageType(file.mediaType);
  // Named again here, for a file stored by another store or an older
  // version under a name that does not end in its type's extension.
  const name = storedName(file.name, known ? file.mediaType : "");
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": type,
      "content-length": String(file.bytes.byteLength),
      "x-content-type-options": "nosniff",
      "content-disposition": `${inline ? "inline" : "attachment"}; ${dispositionName(name)}`,
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      vary: "Cookie",
    },
  });
}

/**
 * The answer to a send that was refused, for a browser with no script: the
 * reason, the text the reader had typed (so it is not lost), and a way
 * back. The page's script reads the message out of it and shows it in the
 * composer instead.
 */
export function refusedPage(
  message: string,
  text: string,
  page: string,
): Response {
  // Bascik's html template escapes every value and checks the link's URL.
  const body = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Not sent</title>
      </head>
      <body>
        <main>
          <h1>Not sent</h1>
          <p role="alert" data-testid="attach-refused">${message}</p>
          ${
            text
              ? html`<p>Your message, to copy:</p>
                  <textarea
                    readonly
                    rows="6"
                    cols="60"
                    data-testid="attach-refused-text"
                  >
${text}</textarea>`
              : ""
          }
          <p>
            <a href="${page}" data-testid="attach-refused-back"
              >Back to the chat</a
            >
          </p>
        </main>
      </body>
    </html> `.toString();
  return new Response(body, {
    status: 422,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    },
  });
}
