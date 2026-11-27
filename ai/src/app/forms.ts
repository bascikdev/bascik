/**
 * Reading what a form handler is sent: the body, counted as it streams so a
 * large one is cut off, its fields, the message a form stands for, a `back`
 * field kept to a path on this site, and the check that a request that
 * changes something was not sent by another site's page.
 */

/**
 * A path on this site: one slash first, never `//host` or `/\host`, and no
 * control characters (a URL parser drops a tab, so `/\t/host` is `//host`).
 */
const LOCAL_PATH = /^\/(?![/\\])[^\u0000-\u001f\u007f]*$/;
/** Where a `back` field sends the reader: its path on this site, or undefined. */
export function localPath(back: string | undefined): string | undefined {
  if (back === undefined || !LOCAL_PATH.test(back)) return undefined;
  // Resolved the way a browser resolves Location, then kept only when it
  // stays on the same origin and the result is itself a local path: taking
  // out dot segments can leave `//host` (`/.//host`, `/a/..//host`,
  // `/%2e//host`), which the browser would then resolve to another site.
  const base = "http://this.invalid";
  const url = new URL(back, base);
  const path = `${url.pathname}${url.search}${url.hash}`;
  return url.origin === base && LOCAL_PATH.test(path) ? path : undefined;
}

/**
 * The answer to a request that changes something and was sent by another
 * site's page, or null when it may go on. A browser says where a request
 * came from: `Sec-Fetch-Site` is trusted when it is there, and without it
 * the `Origin` has to name this host (as `Host`, `X-Forwarded-Host` or the
 * request's URL has it). A request with neither header is not a browser's,
 * and goes on: a cookie is no use to another site without a browser.
 */
export function crossSite(request: Request): Response | null {
  const refused = (): Response =>
    new Response("This request came from another site.", {
      status: 403,
      headers: { "cache-control": "no-store" },
    });
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    return site.trim().toLowerCase() === "cross-site" ? refused() : null;
  }
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  let from: string;
  try {
    from = new URL(origin).host;
  } catch {
    // `null`, as a sandboxed frame or a redirect sends, names no site.
    return refused();
  }
  const forwarded = request.headers.get("x-forwarded-host");
  const here = [
    request.headers.get("host"),
    forwarded === null ? null : forwarded.split(",")[0]!.trim(),
    new URL(request.url).host,
  ];
  return here.some((host) => host?.toLowerCase() === from) ? null : refused();
}

export const field = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
};

/** A form with a `text` field sends that; any other form sends `Label: value` lines. */
export function messageFrom(form: FormData): string {
  const text = form.get("text");
  if (typeof text === "string") return text.trim();
  const lines: string[] = [];
  for (const [name, value] of form) {
    // `app` names which chat the form is for, and `voice` how to answer it.
    if (
      name !== "app" &&
      name !== "voice" &&
      typeof value === "string" &&
      value.trim()
    ) {
      lines.push(`${name}: ${value.trim()}`);
    }
  }
  return lines.join("\n");
}

/**
 * The request's form, or why there is none: it is not a form, or it is longer
 * than `limit` bytes. The body is counted as it streams, so a body with no
 * Content-Length (or a false one) is cut off at the limit, never read whole.
 */
export async function readForm(
  request: Request,
  limit: number,
): Promise<FormData | "not a form" | "too large"> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) return "too large";
  let over = false;
  let seen = 0;
  const body =
    request.body?.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limit) {
            over = true;
            controller.error(new RangeError("The body is too large."));
          } else {
            controller.enqueue(chunk);
          }
        },
      }),
    ) ?? null;
  const type = request.headers.get("content-type");
  try {
    return await new Response(body, {
      headers: type === null ? {} : { "content-type": type },
    }).formData();
  } catch {
    return over ? "too large" : "not a form";
  }
}
