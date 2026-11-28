import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  announce,
  closestPart,
  findPart,
  isPart,
  liveTurn,
  newMarker,
  newTurn,
  partIn,
  partSelector,
  rootOf,
  roots,
  selectorBefore,
  setState,
} from "./parts.ts";

/*
 * A page small enough to read: elements with attributes, a parent and
 * children, and the three lookups the module uses. Selectors are the kind
 * the module writes: lists of `[name]`, `[name="value"]`, `#id` and
 * `:not([name="value"])`, with no combinators.
 */
type Attributes = Record<string, string>;

const SIMPLE =
  /\[([\w-]+)(?:="([^"]*)")?\]|#([\w-]+)|:not\(\[([\w-]+)(?:="([^"]*)")?\]\)/y;

function compoundMatches(element: FakeElement, compound: string): boolean {
  let at = 0;
  while (at < compound.length) {
    SIMPLE.lastIndex = at;
    const found = SIMPLE.exec(compound);
    if (!found)
      throw new Error(`a selector the test page cannot read: ${compound}`);
    const [, name, value, id, notName, notValue] = found;
    const has = (key: string, wanted: string | undefined): boolean =>
      key in element.attributes &&
      (wanted === undefined || element.attributes[key] === wanted);
    if (name !== undefined && !has(name, value)) return false;
    if (id !== undefined && element.attributes.id !== id) return false;
    if (notName !== undefined && has(notName, notValue)) return false;
    at = SIMPLE.lastIndex;
  }
  return true;
}

class FakeNode {
  children: FakeElement[] = [];
  parent: FakeNode | null = null;
  ownerDocument!: FakeDocument;

  append(...added: FakeElement[]): void {
    for (const child of added) {
      child.parent = this;
      this.children.push(child);
    }
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const inside = child.querySelector(selector);
      if (inside) return inside;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

class FakeElement extends FakeNode {
  attributes: Attributes = {};
  classList = { add: (name: string) => void (this.className += ` ${name}`) };
  className = "";
  heard: { type: string; detail: unknown }[] = [];
  readonly localName: string;

  constructor(localName: string, page: FakeDocument) {
    super();
    this.localName = localName;
    this.ownerDocument = page;
  }

  /** `dataset.chatPart` is the attribute `data-chat-part`, as in a browser. */
  get dataset(): Record<string, string> {
    const attribute = (key: string): string =>
      `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
    return new Proxy(
      {},
      {
        get: (_, key: string) => this.attributes[attribute(key)],
        set: (_, key: string, value: string) => {
          this.attributes[attribute(key)] = value;
          return true;
        },
        deleteProperty: (_, key: string) =>
          delete this.attributes[attribute(key)],
      },
    );
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .some((compound) => compoundMatches(this, compound.trim()));
  }

  closest(selector: string): FakeElement | null {
    for (
      let at: FakeNode | null = this;
      at instanceof FakeElement;
      at = at.parent
    ) {
      if (at.matches(selector)) return at;
    }
    return null;
  }

  dispatchEvent(event: {
    type: string;
    detail: unknown;
    bubbles: boolean;
  }): void {
    this.heard.push({ type: event.type, detail: event.detail });
    const up = this.parent;
    if (!event.bubbles) return;
    if (up instanceof FakeElement) up.dispatchEvent(event);
    else
      this.ownerDocument.heard.push({ type: event.type, detail: event.detail });
  }
}

class FakeDocument extends FakeNode {
  documentElement: FakeElement;
  heard: { type: string; detail: unknown }[] = [];

  constructor() {
    super();
    this.ownerDocument = this;
    this.documentElement = new FakeElement("html", this);
    this.append(this.documentElement);
  }

  createElement(name: string): FakeElement {
    return new FakeElement(name, this);
  }

  dispatchEvent(event: { type: string; detail: unknown }): void {
    this.heard.push({ type: event.type, detail: event.detail });
  }
}

/** An element with `attributes` and `children`, in `page`. */
function el(
  page: FakeDocument,
  attributes: Attributes,
  ...children: FakeElement[]
): FakeElement {
  const made = page.createElement("div");
  made.attributes = { ...attributes };
  made.append(...children);
  return made;
}

/** The fake page as the module sees one. */
const seen = <T>(value: unknown): T => value as T;

let page: FakeDocument;
const kept: Record<string, unknown> = {};

beforeEach(() => {
  page = new FakeDocument();
  for (const name of ["document", "Element", "CustomEvent"]) {
    kept[name] = Reflect.get(globalThis, name);
  }
  Reflect.set(globalThis, "document", page);
  Reflect.set(globalThis, "Element", FakeElement);
  Reflect.set(
    globalThis,
    "CustomEvent",
    class {
      type: string;
      bubbles: boolean;
      detail: unknown;
      constructor(type: string, init: { bubbles: boolean; detail: unknown }) {
        this.type = type;
        this.bubbles = init.bubbles;
        this.detail = init.detail;
      }
    },
  );
});

afterEach(() => {
  for (const [name, value] of Object.entries(kept)) {
    if (value === undefined) Reflect.deleteProperty(globalThis, name);
    else Reflect.set(globalThis, name, value);
  }
});

describe("selectors", () => {
  test("a part is marked with data-chat-part", () => {
    expect(partSelector("thread")).toBe('[data-chat-part="thread"]');
  });

  test("a part from before is found by the test hook it had, or the ready marker's id", () => {
    expect(selectorBefore("thread")).toBe('[data-testid="chat-thread"]');
    expect(selectorBefore("input")).toBe('[data-testid="chat-composer-input"]');
    expect(selectorBefore("stop")).toBe('[data-testid="chat-composer-stop"]');
    expect(selectorBefore("sidebar")).toBe('[data-testid="chat-sidebar"]');
    expect(selectorBefore("view")).toBe('[data-testid="voice-view"]');
    expect(selectorBefore("ready")).toBe("#thread-ready");
  });

  test("no selector names a class, which a component's own styles could rename", () => {
    const parts = [
      "thread",
      "turn",
      "writing",
      "done",
      "ready",
      "welcome",
      "composer",
      "input",
      "notice",
      "send",
      "stop",
      "sidebar",
      "view",
      "failed",
    ] as const;
    for (const part of parts) {
      expect(selectorBefore(part), part).not.toMatch(/(^|[\s,>+~(])\.[\w-]/);
      expect(partSelector(part), part).not.toContain(".");
    }
  });
});

describe("a page with a chat root", () => {
  let first: FakeElement;
  let second: FakeElement;
  let firstThread: FakeElement;
  let secondThread: FakeElement;
  let firstInput: FakeElement;
  let sidebar: FakeElement;

  beforeEach(() => {
    firstThread = el(page, { "data-chat-part": "thread" });
    firstInput = el(page, { "data-chat-part": "input" });
    secondThread = el(page, { "data-chat-part": "thread" });
    first = el(
      page,
      { "data-chat": "" },
      el(page, { "data-chat-part": "composer" }, firstInput),
      firstThread,
    );
    second = el(page, { "data-chat": "" }, secondThread);
    // Marked, but outside both chats: only its hook from before reaches it.
    sidebar = el(page, {
      "data-chat-part": "sidebar",
      "data-testid": "chat-sidebar",
    });
    page.documentElement.append(sidebar, first, second);
  });

  test("the root of an element is the nearest one that holds it, or itself", () => {
    expect(rootOf(seen(firstInput))).toBe(first);
    expect(rootOf(seen(first))).toBe(first);
    expect(rootOf(seen(sidebar))).toBeNull();
    expect(rootOf(null)).toBeNull();
  });

  test("a part is found in the chat the element belongs to, not in another", () => {
    expect(findPart(seen(firstInput), "thread")).toBe(firstThread);
    expect(findPart(seen(secondThread), "thread")).toBe(secondThread);
    expect(findPart(seen(second), "thread")).toBe(secondThread);
  });

  test("a part outside every chat is found from any of them", () => {
    expect(findPart(seen(firstInput), "sidebar")).toBe(sidebar);
    expect(findPart(seen(second), "sidebar")).toBe(sidebar);
    expect(findPart(seen(second), "input")).toBeNull();
  });

  test("a part one chat lacks is never taken from the other, marked or by its hook from before", () => {
    const notice = el(page, {
      "data-chat-part": "notice",
      "data-testid": "chat-composer-notice",
    });
    first.append(notice);
    expect(findPart(seen(firstInput), "notice")).toBe(notice);
    expect(findPart(seen(secondThread), "notice")).toBeNull();
  });

  test("a part written the old way inside a chat is found by its hook, in that chat", () => {
    const firstStop = el(page, { "data-testid": "chat-composer-stop" });
    const secondStop = el(page, { "data-testid": "chat-composer-stop" });
    first.append(firstStop);
    second.append(secondStop);
    expect(findPart(seen(secondThread), "stop")).toBe(secondStop);
    expect(findPart(seen(firstInput), "stop")).toBe(firstStop);
  });

  test("the reply being written in one chat is not the other's", () => {
    const live = el(page, {
      "data-chat-part": "turn",
      "data-live": "",
      "data-testid": "turn-live",
    });
    secondThread.append(live);
    expect(liveTurn(seen(firstInput))).toBeNull();
    expect(liveTurn(seen(second))).toBe(live);
  });

  test("state is written on the root and on <html>, and taken away from both", () => {
    setState(seen(firstInput), "genui", "streaming");
    expect(first.attributes["data-genui"]).toBe("streaming");
    expect(page.documentElement.attributes["data-genui"]).toBe("streaming");
    expect(second.attributes["data-genui"]).toBeUndefined();
    setState(seen(firstInput), "genuiCall", "on");
    expect(first.attributes["data-genui-call"]).toBe("on");
    setState(seen(firstInput), "genuiCall", null);
    expect("data-genui-call" in first.attributes).toBe(false);
    expect("data-genui-call" in page.documentElement.attributes).toBe(false);
  });

  test("an event is announced from the root and bubbles to the page", () => {
    announce(seen(firstInput), "chat:send", { form: "the form" });
    expect(first.heard).toEqual([
      { type: "chat:send", detail: { form: "the form" } },
    ]);
    expect(second.heard).toEqual([]);
    expect(page.heard.map((event) => event.type)).toEqual(["chat:send"]);
  });

  test("every root is listed", () => {
    expect(roots(seen(page))).toEqual([first, second]);
  });

  test("the reply being written is the live turn, never the placeholder for one", () => {
    const placeholder = el(page, {
      "data-chat-part": "turn",
      "data-live": "",
      "aria-busy": "true",
    });
    firstThread.append(placeholder);
    expect(liveTurn(seen(firstInput))).toBeNull();
    const live = el(page, { "data-chat-part": "turn", "data-live": "" });
    firstThread.append(live);
    expect(liveTurn(seen(firstInput))).toBe(live);
    expect(liveTurn(seen(second))).toBeNull();
  });
});

describe("a page written before the parts were marked", () => {
  let thread: FakeElement;
  let composer: FakeElement;
  let stop: FakeElement;
  let live: FakeElement;
  let done: FakeElement;

  beforeEach(() => {
    done = el(page, { "data-testid": "turn-done" });
    live = el(page, { "data-testid": "turn-live" }, done);
    thread = el(
      page,
      { "data-testid": "chat-thread" },
      el(page, { id: "thread-ready" }),
      live,
    );
    stop = el(page, { "data-testid": "chat-composer-stop" });
    composer = el(
      page,
      { "data-testid": "chat-composer" },
      el(page, { "data-testid": "chat-composer-input" }),
      stop,
    );
    page.documentElement.append(composer, thread);
  });

  test("has no root", () => {
    expect(rootOf(seen(composer))).toBeNull();
    expect(roots(seen(page))).toEqual([page.documentElement]);
  });

  test("every part is found by its hook from before", () => {
    expect(findPart(seen(composer), "thread")).toBe(thread);
    expect(findPart(seen(page.documentElement), "thread")).toBe(thread);
    expect(findPart(seen(thread), "input")).toBe(composer.children[0]);
    expect(partIn(seen(page), "ready")).toBe(thread.children[0]);
    expect(partIn(seen(live), "done")).toBe(done);
    expect(liveTurn(seen(composer))).toBe(live);
  });

  test("an element is known for the part it is, and a click inside one finds it", () => {
    expect(isPart(seen(composer), "composer")).toBe(true);
    expect(isPart(seen(thread), "composer")).toBe(false);
    const inside = el(page, {});
    stop.append(inside);
    expect(closestPart(seen(inside), "stop")).toBe(stop);
    expect(closestPart(seen(thread), "stop")).toBeNull();
  });

  test("state is written on <html> alone", () => {
    setState(seen(composer), "genui", "idle");
    expect(page.documentElement.attributes["data-genui"]).toBe("idle");
    expect(composer.attributes["data-genui"]).toBeUndefined();
  });

  test("an event is announced from the document", () => {
    announce(seen(composer), "chat:reply-end", { stopped: true });
    expect(page.heard).toEqual([
      { type: "chat:reply-end", detail: { stopped: true } },
    ]);
    expect(composer.heard).toEqual([]);
  });
});

describe("a marked part wins over a hook from before", () => {
  test("in the same chat", () => {
    const old = el(page, { "data-testid": "chat-thread" });
    const marked = el(page, { "data-chat-part": "thread" });
    const root = el(page, { "data-chat": "" }, old, marked);
    page.documentElement.append(root);
    expect(findPart(seen(root), "thread")).toBe(marked);
    expect(partIn(seen(root), "thread")).toBe(marked);
  });
});

describe("what a script adds to the thread", () => {
  test("a reader's turn is the server's: a paragraph with the marks, the class and the hook", () => {
    const turn = seen<FakeElement>(newTurn("user", "turn-user", seen(page)));
    expect(turn.localName).toBe("p");
    expect(turn.className).toBe("turn-user");
    expect(turn.attributes).toEqual({
      "data-chat-part": "turn",
      "data-role": "user",
      "data-testid": "turn-user",
    });
  });

  test("a reply is a block with the marks, the class and the hook it is given", () => {
    const turn = seen<FakeElement>(
      newTurn("assistant", "turn-voice", seen(page)),
    );
    expect(turn.localName).toBe("div");
    expect(turn.className).toBe("turn-assistant");
    expect(turn.attributes).toEqual({
      "data-chat-part": "turn",
      "data-role": "assistant",
      "data-testid": "turn-voice",
    });
  });

  test("a marker is an empty span with its class and its mark", () => {
    for (const part of ["writing", "done"] as const) {
      const marker = seen<FakeElement>(newMarker(part, seen(page)));
      expect(marker.localName).toBe("span");
      expect(marker.className).toBe(part);
      expect(marker.attributes).toEqual({ "data-chat-part": part });
    }
  });
});
