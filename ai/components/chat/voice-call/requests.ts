/*
 * voice-call's requests to the app's own routes: a form post that names the
 * app, and the /voice-view page that holds what a tool call shows. A view's
 * scripts are made again here, since a script parsed elsewhere does not run.
 */

/** POST `fields` and the app's name to `path`, as a form. */
export function postForm(
  app: string,
  path: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const body = new FormData();
  body.set("app", app);
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return fetcher(path, { method: "POST", body, signal });
}

/** Where the view of one tool call is rendered. */
export const viewUrl = (app: string, id: string): string =>
  `/voice-view?app=${encodeURIComponent(app)}&call=${encodeURIComponent(id)}`;

/** The view a call showed, as the server renders it, or null when there is none. */
export async function fetchView(
  app: string,
  id: string,
): Promise<Element | null> {
  const response = await fetch(viewUrl(app, id));
  if (!response.ok) return null;
  const page = new DOMParser().parseFromString(
    await response.text(),
    "text/html",
  );
  // A data attribute is not renamed per instance, so it can be selected as written.
  // bascik-ignore js-attribute-selector
  return page.querySelector('[data-testid="voice-view"]');
}

/**
 * The view's contents in this page, in a holder marked with the call's id.
 * Its components arrive as finished markup; each script is made again, so
 * that it runs.
 */
export function viewHolder(view: Element, id: string): HTMLElement {
  const holder = document.createElement("div");
  holder.dataset.view = id;
  holder.append(
    ...[...view.childNodes].map((node) => document.importNode(node, true)),
  );
  for (const parsed of holder.querySelectorAll("script")) {
    const script = document.createElement("script");
    for (const { name, value } of parsed.attributes) {
      script.setAttribute(name, value);
    }
    script.textContent = parsed.textContent;
    parsed.replaceWith(script);
  }
  return holder;
}
