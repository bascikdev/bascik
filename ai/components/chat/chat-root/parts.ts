/*
 * How the chat's parts find each other, share state and say what happened.
 *
 * One element holds a chat: it carries `data-chat`. Inside it every part is
 * marked with `data-chat-part`, and a script looks a part up from the nearest
 * root, never across the whole page. A page written before these attributes
 * existed still works: each lookup falls back to the hook that part had then.
 *
 * State (`data-genui`, `data-genui-call`) is written on the root and on
 * <html>, and what happens is announced with bubbling `chat:*` events from
 * the root, so a project can react without editing its copy of a part.
 */

/** The parts a script may look up. */
export type ChatPart =
  | "thread"
  | "turn"
  | "writing"
  | "done"
  | "ready"
  | "welcome"
  | "composer"
  | "input"
  | "notice"
  | "send"
  | "stop"
  | "sidebar"
  | "view"
  | "failed";

/** What is announced from the root, in the order it happens. */
export type ChatEvent =
  | "chat:send"
  | "chat:reply-start"
  | "chat:reply-end"
  | "chat:stop"
  | "chat:call-start"
  | "chat:call-end";

/** The state attributes, by their `dataset` names. */
export type ChatState = "genui" | "genuiCall";

const ROOT = "[data-chat]";

const byTestId = (id: string): string => `[data-testid="${id}"]`;

/** How each part was found before it was marked: by its test hook, or its id. */
const BEFORE: Readonly<Record<ChatPart, string>> = {
  thread: byTestId("chat-thread"),
  turn: `${byTestId("turn-user")}, ${byTestId("turn-assistant")}, ${byTestId("turn-live")}`,
  writing: byTestId("turn-writing"),
  done: byTestId("turn-done"),
  ready: "#thread-ready",
  welcome: byTestId("chat-welcome"),
  composer: byTestId("chat-composer"),
  input: byTestId("chat-composer-input"),
  notice: byTestId("chat-composer-notice"),
  send: byTestId("chat-composer-send"),
  stop: byTestId("chat-composer-stop"),
  sidebar: byTestId("chat-sidebar"),
  view: byTestId("voice-view"),
  failed: byTestId("turn-failed"),
};

/** The selector for a part as it is marked now. */
export const partSelector = (part: ChatPart): string =>
  `[data-chat-part="${part}"]`;

/** The selector for a part as it was found before it was marked. */
export const selectorBefore = (part: ChatPart): string => BEFORE[part];

/*
 * A form's controls are also its properties, by name, and they win over the
 * form's own: `<input name="closest">` makes `form.closest` that input. The
 * model names the fields of the forms it writes, so an element is asked
 * through the prototype here, never by its own property names.
 */
const closest = (from: Element, selector: string): Element | null =>
  Element.prototype.closest.call(from, selector);
const matches = (from: Element, selector: string): boolean =>
  Element.prototype.matches.call(from, selector);

/** The chat `from` belongs to: the nearest element with `data-chat`, or null on a page with none. */
export const rootOf = (from: Element | null | undefined): HTMLElement | null =>
  from ? (closest(from, ROOT) as HTMLElement | null) : null;

/**
 * The first match for `selector` that no chat holds. A part outside every
 * chat (a sidebar beside the root) belongs to the page, and any chat may use
 * it; a part inside another chat is that chat's alone.
 */
function outsideEveryChat<T extends Element>(
  page: Document,
  selector: string,
): T | null {
  for (const found of page.querySelectorAll<T>(selector)) {
    if (!rootOf(found)) return found;
  }
  return null;
}

/**
 * The first match for the marked selector, then for the one from before,
 * in the chat `from` belongs to, then among what no chat holds. A page with
 * no root is searched whole.
 */
function inOwnChat<T extends Element>(
  from: Element | null | undefined,
  marked: string,
  before: string,
): T | null {
  const page = from?.ownerDocument ?? document;
  const root = rootOf(from);
  if (!root) {
    return page.querySelector<T>(marked) ?? page.querySelector<T>(before);
  }
  return (
    root.querySelector<T>(marked) ??
    root.querySelector<T>(before) ??
    outsideEveryChat<T>(page, marked) ??
    outsideEveryChat<T>(page, before)
  );
}

/**
 * A part of the chat `from` belongs to. It is looked for inside the nearest
 * root, by `data-chat-part` and then by the hook the part had before, and
 * then among the parts no chat holds. Another chat's part is never returned.
 * A page with no root is searched whole.
 */
export function findPart<T extends Element = HTMLElement>(
  from: Element | null | undefined,
  part: ChatPart,
): T | null {
  return inOwnChat<T>(from, partSelector(part), BEFORE[part]);
}

/** A part inside `within`, which may be a page that was fetched: marked, or by its hook from before. */
export const partIn = <T extends Element = HTMLElement>(
  within: ParentNode,
  part: ChatPart,
): T | null =>
  within.querySelector<T>(partSelector(part)) ??
  within.querySelector<T>(BEFORE[part]);

/** Whether `element` is that part itself. */
export const isPart = (element: Element, part: ChatPart): boolean =>
  matches(element, `${partSelector(part)}, ${BEFORE[part]}`);

/** The part `from` is in, or is: for a click that lands inside one. */
export const closestPart = <T extends Element = HTMLElement>(
  from: Element,
  part: ChatPart,
): T | null =>
  closest(from, `${partSelector(part)}, ${BEFORE[part]}`) as T | null;

/**
 * The reply being written in the chat `from` belongs to. The placeholder
 * the client runtime shows before an answer starts (`aria-busy`) is not one.
 */
export function liveTurn(from: Element | null | undefined): HTMLElement | null {
  return inOwnChat<HTMLElement>(
    from,
    `${partSelector("turn")}[data-live]:not([aria-busy="true"])`,
    byTestId("turn-live"),
  );
}

/**
 * Set a state attribute, or take it away with `null`, on the root `from`
 * belongs to and on <html>, where styles and other scripts read it.
 */
export function setState(
  from: Element | null | undefined,
  state: ChatState,
  value: string | null,
): void {
  const page = from?.ownerDocument ?? document;
  for (const holder of [rootOf(from), page.documentElement]) {
    if (!holder) continue;
    if (value === null) delete holder.dataset[state];
    else holder.dataset[state] = value;
  }
}

/** Every chat on the page, or the page itself when none is marked. */
export const roots = (page: Document = document): HTMLElement[] => {
  const marked = [...page.querySelectorAll<HTMLElement>(ROOT)];
  return marked.length ? marked : [page.documentElement];
};

/**
 * Announce something that happened in the chat `from` belongs to: a bubbling
 * event from its root, or from the document on a page with no root.
 */
export function announce(
  from: Element | null | undefined,
  type: ChatEvent,
  detail: Record<string, unknown> = {},
): void {
  const target: EventTarget = rootOf(from) ?? from?.ownerDocument ?? document;
  target.dispatchEvent(new CustomEvent(type, { bubbles: true, detail }));
}

/**
 * A turn as a script adds one to the thread: the element the server writes
 * for that role, with the same marks, classes and test hook.
 */
export function newTurn(
  role: "user" | "assistant",
  testid: string,
  page: Document = document,
): HTMLElement {
  const turn = page.createElement(role === "user" ? "p" : "div");
  turn.className = role === "user" ? "turn-user" : "turn-assistant";
  turn.dataset.chatPart = "turn";
  turn.dataset.role = role;
  turn.dataset.testid = testid;
  return turn;
}

/** The empty marker that ends a reply (`done`) or starts one (`writing`). */
export function newMarker(
  part: "writing" | "done",
  page: Document = document,
): HTMLElement {
  const marker = page.createElement("span");
  marker.className = part;
  marker.dataset.chatPart = part;
  return marker;
}
