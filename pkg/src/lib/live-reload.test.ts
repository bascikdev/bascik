import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  LIVE_RELOAD_SCRIPT,
  LIVE_RELOAD_SCRIPT_ATTR,
  LIVE_RELOAD_VERSION_ATTR,
  liveReloadVersionOf,
  getLiveReloadScript,
  stripLiveReloadScript,
} from "./live-reload.ts";
import { BOOT_PAGE_HTML } from "./boot-page.ts";
import { domSnapshot } from "./html-parse-oracle.test-helper.ts";
import { scanHtml } from "./html-scanner.ts";

const isLiveReloadScript = (script: { attrs: Array<{ name: string }> }) =>
  script.attrs.some((attribute) => attribute.name === LIVE_RELOAD_SCRIPT_ATTR);

/**
 * Stripping must remove the live-reload script elements and change nothing
 * else. Where malformed SVG or MathML stops the scan, later ones may stay,
 * but stripping still never adds or alters anything. Whitespace is set aside
 * because a parser drops whitespace that becomes leading once a script
 * before it is gone; stripping itself never edits text.
 */
const expectOnlyLiveReloadRemoved = (html: string): string => {
  const stripped = stripLiveReloadScript(html);
  const options = { ignoreWhitespace: true, collectScript: isLiveReloadScript };
  const before = domSnapshot(html, options);
  const after = domSnapshot(stripped, options);
  expect(after.structure).toBe(before.structure);
  if (scanHtml(html).stoppedAt === html.length)
    expect(after.scripts).toEqual([]);
  else
    for (const script of after.scripts)
      expect(before.scripts).toContain(script);
  return stripped;
};

describe("LIVE_RELOAD_SCRIPT", () => {
  it("contains script tag wrapper marked with the owned attribute", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain(`<script ${LIVE_RELOAD_SCRIPT_ATTR}>`);
    expect(LIVE_RELOAD_SCRIPT).toContain("</script>");
    expect(LIVE_RELOAD_SCRIPT_ATTR).toBe("data-bascik-live-reload");
  });

  it("contains banner DOM creation logic and element ID", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain("bascik-live-reload-banner");
    expect(LIVE_RELOAD_SCRIPT).toContain("showBanner");
    expect(LIVE_RELOAD_SCRIPT).toContain("removeBanner");
  });

  it("contains reconnecting and offline banner status messages", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain(
      "Live reload disconnected. Reconnecting",
    );
    expect(LIVE_RELOAD_SCRIPT).toContain(
      "Dev server offline. Will reconnect automatically when server restarts.",
    );
  });

  it("contains automatic reconnection on tab focus and visibilitychange", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain("instantConnect");
    expect(LIVE_RELOAD_SCRIPT).toContain(
      "addEventListener('focus', instantConnect)",
    );
  });

  it("clears banner when connected message is received", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain("removeBanner()");
  });

  it("does not reconnect on focus when already connected, but reconnects when disconnected", () => {
    const listeners: Record<string, Function[]> = {};
    let reloadCalls = 0;
    const eventSourceInstances: any[] = [];

    class MockEventSource {
      url: string;
      readyState = 1; // OPEN
      onmessage: ((e: any) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      addEventListener = vi.fn();

      constructor(url: string) {
        this.url = url;
        eventSourceInstances.push(this);
      }

      close() {
        this.closed = true;
        this.readyState = 2; // CLOSED
      }
    }

    const mockWindow = {
      location: {
        reload: () => {
          reloadCalls++;
        },
      },
      addEventListener: (type: string, fn: Function) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
    };

    const mockDocument = {
      visibilityState: "visible",
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({
        style: {},
        parentNode: null,
        setAttribute: () => {},
        appendChild: () => {},
      }),
      addEventListener: (type: string, fn: Function) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
    };

    const scriptCode = LIVE_RELOAD_SCRIPT.replace(
      `<script ${LIVE_RELOAD_SCRIPT_ATTR}>`,
      "",
    ).replace("</script>", "");

    const runScript = new Function(
      "window",
      "document",
      "EventSource",
      scriptCode,
    );
    runScript(mockWindow, mockDocument, MockEventSource);

    expect(eventSourceInstances.length).toBe(1);
    const es1 = eventSourceInstances[0];

    // Simulate initial connection message
    es1.onmessage({ data: "connected" });
    expect(reloadCalls).toBe(0);

    // Trigger focus while still connected
    if (listeners["focus"]) {
      listeners["focus"].forEach((fn) => fn());
    }

    // Should NOT have created a second EventSource or reloaded
    expect(eventSourceInstances.length).toBe(1);
    expect(reloadCalls).toBe(0);

    // Now simulate connection error / disconnection
    es1.onerror();
    expect(es1.closed).toBe(true);

    // Trigger focus while disconnected
    if (listeners["focus"]) {
      listeners["focus"].forEach((fn) => fn());
    }

    // Should have created a new EventSource to reconnect
    expect(eventSourceInstances.length).toBe(2);
    const es2 = eventSourceInstances[1];

    // Simulate new connection succeeding
    es2.onmessage({ data: "connected" });

    // Since it was previously connected before disconnection, it should now reload
    expect(reloadCalls).toBe(1);
  });

  // F082: the offline banner promises to reconnect when the server
  // restarts; a tab that stays focused and visible must keep trying.
  it("keeps retrying slowly after the fast retries, so a focused tab reconnects after a restart", () => {
    vi.useFakeTimers();
    try {
      let reloadCalls = 0;
      const instances: any[] = [];
      class MockEventSource {
        static CLOSED = 2;
        url: string;
        readyState = 0;
        onmessage: ((e: any) => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener = vi.fn();
        constructor(url: string) {
          this.url = url;
          instances.push(this);
        }
        close() {
          this.readyState = 2;
        }
      }
      const banners: string[] = [];
      const bannerElement: any = {
        style: {},
        parentNode: null,
        setAttribute: () => {},
        appendChild: () => {},
      };
      Object.defineProperty(bannerElement, "innerHTML", {
        set: (html: string) => banners.push(html),
      });
      // The banner's message is set as text.
      Object.defineProperty(bannerElement, "textContent", {
        set: (text: string) => banners.push(text),
      });
      const mockWindow = {
        location: { reload: () => reloadCalls++ },
        addEventListener: () => {},
      };
      const mockDocument = {
        visibilityState: "visible",
        getElementById: () => null,
        body: {
          appendChild: (el: any) => {
            el.parentNode = mockDocument.body;
          },
          removeChild: () => {},
        },
        createElement: () => bannerElement,
        addEventListener: () => {},
      };
      const scriptCode = LIVE_RELOAD_SCRIPT.replace(
        `<script ${LIVE_RELOAD_SCRIPT_ATTR}>`,
        "",
      ).replace("</script>", "");
      new Function("window", "document", "EventSource", scriptCode)(
        mockWindow,
        mockDocument,
        MockEventSource,
      );

      instances[0].onmessage({ data: "connected" });
      // The server stops: the first connection and 5 fast retries fail.
      instances[0].onerror();
      for (let i = 1; i <= 5; i++) {
        vi.advanceTimersByTime(1000);
        expect(instances).toHaveLength(i + 1);
        instances[i].onerror();
      }
      expect(banners.at(-1)).toContain("Dev server offline");

      // Still focused and visible, no focus event: it keeps trying.
      vi.advanceTimersByTime(5000);
      expect(instances).toHaveLength(7);
      instances[6].onerror();
      expect(banners.at(-1)).toContain("Dev server offline");
      vi.advanceTimersByTime(5000);
      expect(instances).toHaveLength(8);

      // The server is back: the tab reloads into the new build.
      instances[7].onmessage({ data: "connected" });
      expect(reloadCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles monotonic generation counter and ignores stale/older generations", () => {
    let reloadCalls = 0;
    const eventSourceInstances: any[] = [];

    class MockEventSource {
      url: string;
      readyState = 1;
      onmessage: ((e: any) => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      addEventListener = vi.fn();

      constructor(url: string) {
        this.url = url;
        eventSourceInstances.push(this);
      }
    }

    const mockWindow = {
      location: {
        reload: () => {
          reloadCalls++;
        },
      },
      addEventListener: () => {},
    };

    const mockDocument = {
      visibilityState: "visible",
      body: { appendChild: () => {}, removeChild: () => {} },
      createElement: () => ({
        style: {},
        parentNode: null,
        setAttribute: () => {},
        appendChild: () => {},
      }),
      addEventListener: () => {},
    };

    const scriptCode = LIVE_RELOAD_SCRIPT.replace(
      `<script ${LIVE_RELOAD_SCRIPT_ATTR}>`,
      "",
    ).replace("</script>", "");

    const runScript = new Function(
      "window",
      "document",
      "EventSource",
      scriptCode,
    );
    runScript(mockWindow, mockDocument, MockEventSource);

    const es = eventSourceInstances[0];

    // Initial connected
    es.onmessage({ data: "connected" });
    expect(reloadCalls).toBe(0);

    // Generation 2 arrives -> triggers reload
    es.onmessage({ data: "reload 2" });
    expect(reloadCalls).toBe(1);

    // Stale generation 1 arrives -> ignored, no reload
    es.onmessage({ data: "reload 1" });
    expect(reloadCalls).toBe(1);

    // Out-of-order stale generation 2 arrives again -> ignored
    es.onmessage({ data: "reload 2" });
    expect(reloadCalls).toBe(1);

    // Generation 3 arrives -> triggers reload
    es.onmessage({ data: "reload 3" });
    expect(reloadCalls).toBe(2);
  });
});

// A page can load its old version and miss the reload for the new one: the
// rebuild finishes (and the reload goes out) before the page's own
// connection opens. CI's dev e2e lane hit this once: one request for the
// page, two rebuilds, and no reload. So each compiled page carries its
// version, the server sends the stored page's version on connect, and a page
// whose version differs reloads.
describe("page versions", () => {
  const run = (version: string | null) => {
    let reloads = 0;
    const sources: { onmessage: (e: { data: string }) => void }[] = [];
    class MockEventSource {
      readyState = 1;
      onmessage: ((e: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener = vi.fn();
      constructor() {
        sources.push(this as never);
      }
    }
    const script = getLiveReloadScript(
      "/bascik-live-reload",
      version ?? undefined,
    );
    const body = script.slice(
      script.indexOf(">") + 1,
      script.lastIndexOf("</script>"),
    );
    new Function("window", "document", "EventSource", body)(
      { location: { reload: () => reloads++ }, addEventListener: () => {} },
      {
        visibilityState: "visible",
        currentScript: {
          getAttribute: (name: string) =>
            name === LIVE_RELOAD_VERSION_ATTR ? version : null,
        },
        body: { appendChild: () => {}, removeChild: () => {} },
        createElement: () => ({
          style: {},
          parentNode: null,
          setAttribute: () => {},
          appendChild: () => {},
        }),
        addEventListener: () => {},
      },
      MockEventSource,
    );
    return {
      send: (data: string) => sources[0].onmessage({ data }),
      reloads: () => reloads,
    };
  };

  it("stamps the script with the page's version, and strips it with the script", () => {
    const script = getLiveReloadScript("/bascik-live-reload", "7");
    expect(script).toContain(`${LIVE_RELOAD_VERSION_ATTR}="7"`);
    expect(stripLiveReloadScript(`<p>a</p>${script}`).trim()).toBe("<p>a</p>");
  });

  it("reloads a page whose version is not the stored one when it connects", () => {
    const page = run("7");
    page.send("connected 8");
    expect(page.reloads()).toBe(1);
  });

  it("does not reload a page that is the stored version, or when either side has none", () => {
    // Each is a first connection: a second one is a reconnect, which reloads.
    const current = run("7");
    current.send("connected 7");
    expect(current.reloads()).toBe(0);
    const unversionedServer = run("7");
    unversionedServer.send("connected");
    expect(unversionedServer.reloads()).toBe(0);
    const unstamped = run(null);
    unstamped.send("connected 8");
    expect(unstamped.reloads()).toBe(0);
  });

  it("reads the version back from the stored page, quoted or minified, last one wins", () => {
    const script = getLiveReloadScript("/r", "12");
    expect(liveReloadVersionOf(`<body>${script}</body>`)).toBe("12");
    expect(
      liveReloadVersionOf(
        `<script ${LIVE_RELOAD_SCRIPT_ATTR} ${LIVE_RELOAD_VERSION_ATTR}=13></script>`,
      ),
    ).toBe("13");
    expect(
      liveReloadVersionOf(
        `<p ${LIVE_RELOAD_VERSION_ATTR}="1"></p>${getLiveReloadScript("/r", "2")}`,
      ),
    ).toBe("2");
    expect(liveReloadVersionOf("<p>no script</p>")).toBeNull();
    expect(
      liveReloadVersionOf(`<p ${LIVE_RELOAD_VERSION_ATTR}="x9"></p>`),
    ).toBeNull();
  });
});

// F055: each page worker has its own counter and every dev rebuild starts a
// fresh pool, so a changed page was re-stamped with the version it had. A
// version now carries the compiling thread, whose id is never reused.
describe("live-reload page versions across threads", () => {
  /** A fresh module instance: a thread that has compiled nothing yet. */
  const freshThread = async () => {
    vi.resetModules();
    return (await import("./live-reload.ts")).nextLiveReloadVersion;
  };

  it("never repeats a version between the main thread and workers of different pools", async () => {
    const main = await freshThread();
    const bootWorker = await freshThread();
    const rebuildWorker = await freshThread();
    const versions = [
      main(0),
      main(0),
      bootWorker(1),
      bootWorker(1),
      rebuildWorker(2),
      rebuildWorker(2),
    ];
    expect(new Set(versions).size).toBe(versions.length);
    // The main thread keeps the plain sequence.
    expect(versions.slice(0, 2)).toEqual(["1", "2"]);
  });

  it("stays digits the stored-page reader reads back whole", async () => {
    const next = await freshThread();
    const version = next(2_000_000);
    expect(version).toMatch(/^\d+$/);
    expect(Number.isSafeInteger(Number(version))).toBe(true);
    expect(
      liveReloadVersionOf(`<body>${getLiveReloadScript("/r", version)}</body>`),
    ).toBe(version);
  });
});

describe("stripLiveReloadScript", () => {
  it("removes only the injected script and never crosses into neighboring scripts", () => {
    const html =
      `<script>window.a = 1</script>` +
      getLiveReloadScript("/sub/bascik-live-reload").trim() +
      `<script>window.b = 2</script>`;
    expect(stripLiveReloadScript(html)).toBe(
      `<script>window.a = 1</script><script>window.b = 2</script>`,
    );
  });

  it("leaves pages untouched when the SSE path appears in prose or client code", () => {
    const html =
      `<script>console.log("first")</script>` +
      `<p>See <code>/bascik-live-reload</code> and bascik-live-reload-banner.</p>` +
      `<script>new EventSource("/bascik-live-reload")</script>`;
    expect(stripLiveReloadScript(html)).toBe(html);
  });

  it("does not treat data-bascik-live-reload-* variants as the injected script", () => {
    const html = `<script data-bascik-live-reload-note="x">window.c = 3</script>`;
    expect(stripLiveReloadScript(html)).toBe(html);
  });

  it("keeps look-alike text that is one odd start tag, which runs nothing", () => {
    // `<scr<script data-bascik-live-reload>` is a single start tag named
    // `scr<script`. Deleting the look-alike would join `<scr` and `ipt>` into
    // an executable `<script>alert(1)</script>`.
    const inner = getLiveReloadScript().trim();
    for (const tail of [
      `ipt ${LIVE_RELOAD_SCRIPT_ATTR}>x()</script>`,
      "ipt>alert(1)</script>",
    ]) {
      const html = `<p>a</p><scr${inner}${tail}<p>b</p>`;
      expect(expectOnlyLiveReloadRemoved(html)).toBe(html);
    }
  });

  it("removes a real live-reload script after a text < without joining the < to what follows", () => {
    const html = `<p>a</p><${getLiveReloadScript().trim()}script>alert(1)</script>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe(
      "<p>a</p><<!---->script>alert(1)</script>",
    );
  });

  it("ignores the attribute name inside another attribute's value", () => {
    const html = `<script data-note=" ${LIVE_RELOAD_SCRIPT_ATTR}">user()</script>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe(html);
  });

  it("removes live-reload scripts in <template> and SVG too, where they could still run", () => {
    const html =
      `<template><script ${LIVE_RELOAD_SCRIPT_ATTR}>t()</script></template>` +
      `<svg><script ${LIVE_RELOAD_SCRIPT_ATTR}>s()</script></svg><p>x</p>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe(
      "<template></template><svg></svg><p>x</p>",
    );
  });

  it("removes the whole script when its body escapes a nested <script>", () => {
    const html = `<p>a</p><script ${LIVE_RELOAD_SCRIPT_ATTR}><!--<script>x()</script>y()--></script><p>b</p>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe("<p>a</p><p>b</p>");
  });

  it("removes exactly the live-reload scripts and nothing else, on random malformed markup", () => {
    const fragment = fc.constantFrom(
      `<script ${LIVE_RELOAD_SCRIPT_ATTR}>lr()</script>`,
      `<script ${LIVE_RELOAD_SCRIPT_ATTR}>`,
      "<script>keep()</script>",
      "<scr",
      `ipt ${LIVE_RELOAD_SCRIPT_ATTR}>`,
      "ipt>",
      "x()",
      "</script>",
      "<!--",
      "-->",
      "<!-- c -->",
      "<",
      ">",
      '"',
      "&am",
      "p;",
      "<p>",
      "</p>",
      '<div title="',
      '">',
      "<template>",
      "</template>",
      "<textarea>",
      "</textarea>",
      "<svg>",
      "</svg>",
      "<foreignObject>",
      "<noscript>",
      "</noscript>",
      "<![CDATA[",
      "]]>",
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 14 }), (parts) => {
        const result = expectOnlyLiveReloadRemoved(parts.join(""));
        expect(stripLiveReloadScript(result)).toBe(result);
      }),
      { numRuns: 3000 },
    );
  });

  it("strips a live-reload script whose end tag carries whitespace or junk", () => {
    const body = getLiveReloadScript()
      .trim()
      .replace(/<\/script>$/, "");
    for (const endTag of [
      "</script >",
      "</SCRIPT>",
      "</script\t\n foo>",
      "</script/>",
    ]) {
      expect(stripLiveReloadScript(`<p>a</p>${body}${endTag}<p>b</p>`)).toBe(
        "<p>a</p><p>b</p>",
      );
    }
  });

  it("handles regex replacement tokens in surrounding content", () => {
    const html = `<p>$& $1 $\`</p>${getLiveReloadScript().trim()}<p>$'</p>`;
    expect(stripLiveReloadScript(html)).toBe("<p>$& $1 $`</p><p>$'</p>");
  });
});

describe("BOOT_PAGE_HTML", () => {
  it("exports valid html buffer containing spinner and initial building text", () => {
    const html = BOOT_PAGE_HTML.toString("utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Building site");
    expect(html).toContain('<div class="spinner"></div>');
  });

  it("contains inlined live-reload script for boot endpoint", () => {
    const html = BOOT_PAGE_HTML.toString("utf8");
    expect(html).toContain("/bascik-live-reload?boot=1");
    expect(html).toContain(
      "Dev server offline. Will reconnect automatically when server restarts.",
    );
  });
});

/**
 * A small DOM stand-in for the dev client's own UI: elements record their tag, attributes, children, listeners,
 * text, and focus, and a <dialog> records showModal() and close(). The real browser behavior (focus moving in and
 * back, Escape, the top layer) is pinned by the dev e2e lane in e2e/tests/dev-server-reload.test.ts.
 */
class FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  style: Record<string, string> = {};
  listeners = new Map<string, Array<(event: unknown) => void>>();
  open = false;
  showModalCalls = 0;
  #text = "";
  #html = "";
  constructor(
    tagName: string,
    readonly doc: FakeDocument,
  ) {
    this.tagName = tagName.toUpperCase();
  }
  get id(): string {
    return this.attributes.get("id") ?? "";
  }
  set id(value: string) {
    this.attributes.set("id", value);
  }
  get type(): string {
    return this.attributes.get("type") ?? "";
  }
  set type(value: string) {
    this.attributes.set("type", value);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  get textContent(): string {
    return this.children.length > 0
      ? this.children.map((child) => child.textContent).join("")
      : this.#text;
  }
  set textContent(value: string) {
    this.children = [];
    this.#text = String(value);
  }
  get innerHTML(): string {
    return this.#html;
  }
  set innerHTML(value: string) {
    this.children = [];
    this.#html = String(value);
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeElement): FakeElement {
    this.children = this.children.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((fn) => fn !== listener),
    );
  }
  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ type, target: this });
  }
  click(): void {
    this.dispatch("click");
  }
  focus(): void {
    this.doc.activeElement = this;
  }
  showModal(): void {
    if (!this.parentNode) throw new Error("showModal on a detached dialog");
    this.open = true;
    this.showModalCalls++;
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  /** Every element below this one, depth first. */
  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.doc.body;
  }
}

class FakeDocument {
  visibilityState = "visible";
  activeElement: FakeElement | null = null;
  body: FakeElement;
  constructor() {
    this.body = new FakeElement("body", this);
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }
  getElementById(id: string): FakeElement | null {
    return this.body.descendants().find((node) => node.id === id) ?? null;
  }
  addEventListener(): void {}
}

/** Run the dev client against the fake DOM; returns the document and the first EventSource. */
function runDevClient() {
  const doc = new FakeDocument();
  const sources: Array<{
    onmessage: ((event: { data: string }) => void) | null;
    onerror: (() => void) | null;
    listeners: Map<string, (event: { data: string }) => void>;
  }> = [];
  class MockEventSource {
    static CLOSED = 2;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    listeners = new Map<string, (event: { data: string }) => void>();
    constructor() {
      sources.push(this);
    }
    addEventListener(type: string, fn: (event: { data: string }) => void) {
      this.listeners.set(type, fn);
    }
    close() {
      this.readyState = 2;
    }
  }
  const win = { location: { reload: vi.fn() }, addEventListener: () => {} };
  const code = LIVE_RELOAD_SCRIPT.replace(
    `<script ${LIVE_RELOAD_SCRIPT_ATTR}>`,
    "",
  ).replace("</script>", "");
  new Function("window", "document", "EventSource", code)(
    win,
    doc,
    MockEventSource,
  );
  const source = sources[0];
  const buildError = (data: string) =>
    source.listeners.get("build-error")!({ data });
  const overlay = () =>
    doc.body.children.find((node) => node.id === "bascik-build-error-overlay");
  const byTestId = (id: string) =>
    doc.body
      .descendants()
      .find((node) => node.getAttribute("data-testid") === id);
  return { doc, source, sources, win, buildError, overlay, byTestId };
}

describe("dev client build-error overlay accessibility", () => {
  const located = JSON.stringify({
    file: "src/pages/index.html",
    line: 12,
    message: "ReferenceError: frothLevel is not defined",
  });

  it("is a modal alert dialog named by its title and described by the error, with focus on Dismiss", () => {
    const { doc, buildError, overlay, byTestId } = runDevClient();
    const previous = doc.createElement("button");
    doc.body.appendChild(previous);
    previous.focus();
    buildError(located);

    const dialog = overlay()!;
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.getAttribute("data-testid")).toBe(
      "bascik-build-error-overlay",
    );
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.showModalCalls).toBe(1);
    const title = doc.getElementById(dialog.getAttribute("aria-labelledby")!)!;
    expect(title.textContent).toBe("Bascik Build Error");
    const details = doc.getElementById(
      dialog.getAttribute("aria-describedby")!,
    )!;
    expect(details.getAttribute("aria-live")).toBe("polite");
    expect(details.textContent).toContain("src/pages/index.html:12");
    expect(details.textContent).toContain(
      "ReferenceError: frothLevel is not defined",
    );
    const dismiss = byTestId("bascik-error-dismiss")!;
    expect(dismiss.tagName).toBe("BUTTON");
    expect(dismiss.type).toBe("button");
    expect(doc.activeElement).toBe(dismiss);
  });

  it("updates the open overlay in place, so focus stays on Dismiss and the dialog is not reopened", () => {
    const { doc, buildError, overlay, byTestId } = runDevClient();
    buildError(located);
    const dialog = overlay()!;
    const dismiss = byTestId("bascik-error-dismiss")!;
    buildError(JSON.stringify({ message: "SyntaxError: second failure" }));
    expect(overlay()).toBe(dialog);
    expect(dialog.showModalCalls).toBe(1);
    expect(byTestId("bascik-error-dismiss")).toBe(dismiss);
    expect(doc.activeElement).toBe(dismiss);
    const details = doc.getElementById(
      dialog.getAttribute("aria-describedby")!,
    )!;
    expect(details.textContent).toContain("SyntaxError: second failure");
    expect(details.textContent).not.toContain("src/pages/index.html");
  });

  it("closes from Dismiss and shows again for the next error (Dismiss used to leave a detached overlay behind)", () => {
    const { buildError, overlay, byTestId } = runDevClient();
    buildError(located);
    byTestId("bascik-error-dismiss")!.click();
    expect(overlay()).toBeUndefined();

    buildError(located);
    expect(overlay()?.isConnected()).toBe(true);
    expect(overlay()!.showModalCalls).toBe(1);
  });

  it("removes itself when the browser closes it (Escape), and shows again for the next error", () => {
    const { buildError, overlay } = runDevClient();
    buildError(located);
    overlay()!.close();
    expect(overlay()).toBeUndefined();
    buildError(located);
    expect(overlay()?.open).toBe(true);
  });

  it("replaces an overlay the browser has closed but not yet removed (its close event is a queued task)", () => {
    const { buildError, overlay } = runDevClient();
    buildError(located);
    const closed = overlay()!;
    // Escape closes the dialog at once; the close event that removes it fires in a later task.
    closed.open = false;
    buildError(located);
    expect(closed.isConnected()).toBe(false);
    expect(overlay()).not.toBe(closed);
    expect(overlay()?.open).toBe(true);
    closed.dispatch("close");
    expect(overlay()?.open).toBe(true);
  });

  it("closes before a reload clears it", () => {
    const { source, buildError, overlay, win } = runDevClient();
    buildError(located);
    const dialog = overlay()!;
    source.onmessage!({ data: "reload 2" });
    expect(dialog.open).toBe(false);
    expect(overlay()).toBeUndefined();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("misuse: shows markup in an error message as text, and a payload that is not JSON as the raw message", () => {
    const { buildError, overlay } = runDevClient();
    buildError(
      JSON.stringify({ message: '<img src=x onerror="alert(1)"> broke' }),
    );
    const html = overlay()!
      .descendants()
      .map((node) => node.innerHTML)
      .join("");
    expect(html).not.toContain("<img");
    expect(overlay()!.textContent).toContain(
      '<img src=x onerror="alert(1)"> broke',
    );

    const raw = runDevClient();
    raw.buildError("plain text failure, not JSON");
    expect(raw.overlay()!.textContent).toContain(
      "plain text failure, not JSON",
    );
  });
});

describe("dev client connection banner accessibility", () => {
  it("is a polite, atomic status region that keeps its element while the message changes", () => {
    vi.useFakeTimers();
    try {
      const { doc, source, sources } = runDevClient();
      source.onerror!();
      const banner = doc.getElementById("bascik-live-reload-banner")!;
      expect(banner.getAttribute("role")).toBe("status");
      expect(banner.getAttribute("aria-live")).toBe("polite");
      expect(banner.getAttribute("aria-atomic")).toBe("true");
      expect(banner.textContent).toContain("Reconnecting (1/5)");
      // The color dot is decoration; only the message is read.
      expect(
        banner.children.filter(
          (node) => node.getAttribute("aria-hidden") !== "true",
        ),
      ).toHaveLength(1);
      // The next retry fails too: the same region is updated, so a screen reader announces the change.
      vi.advanceTimersByTime(1000);
      sources[1].onerror!();
      expect(doc.getElementById("bascik-live-reload-banner")).toBe(banner);
      expect(banner.textContent).toContain("Reconnecting (2/5)");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BOOT_PAGE_HTML accessibility", () => {
  it("puts the status in a main landmark as a status message, and stops the spinner for reduced motion", () => {
    const html = BOOT_PAGE_HTML.toString("utf8");
    expect(html).toMatch(/<main class="box">/);
    expect(html).toMatch(/<p role="status">Building site…<\/p>/);
    expect(html).toMatch(
      /@media \(prefers-reduced-motion: ?reduce\)\{\.spinner\{animation:none\}\}/,
    );
  });
});
