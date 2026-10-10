import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import {
  LIVE_RELOAD_SCRIPT,
  LIVE_RELOAD_SCRIPT_ATTR,
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
  if (scanHtml(html).stoppedAt === html.length) expect(after.scripts).toEqual([]);
  else for (const script of after.scripts) expect(before.scripts).toContain(script);
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
    expect(LIVE_RELOAD_SCRIPT).toContain("Live reload disconnected. Reconnecting");
    expect(LIVE_RELOAD_SCRIPT).toContain("Dev server offline. Will reconnect automatically when server restarts.");
  });

  it("contains automatic reconnection on tab focus and visibilitychange", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain("instantConnect");
    expect(LIVE_RELOAD_SCRIPT).toContain("addEventListener('focus', instantConnect)");
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
      location: { reload: () => { reloadCalls++; } },
      addEventListener: (type: string, fn: Function) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
    };

    const mockDocument = {
      visibilityState: "visible",
      body: { appendChild: () => { }, removeChild: () => { } },
      createElement: () => ({ style: {}, parentNode: null }),
      addEventListener: (type: string, fn: Function) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
    };

    const scriptCode = LIVE_RELOAD_SCRIPT
      .replace(`<script ${LIVE_RELOAD_SCRIPT_ATTR}>`, "")
      .replace("</script>", "");

    const runScript = new Function("window", "document", "EventSource", scriptCode);
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
      location: { reload: () => { reloadCalls++; } },
      addEventListener: () => { },
    };

    const mockDocument = {
      visibilityState: "visible",
      body: { appendChild: () => { }, removeChild: () => { } },
      createElement: () => ({ style: {}, parentNode: null }),
      addEventListener: () => { },
    };

    const scriptCode = LIVE_RELOAD_SCRIPT
      .replace(`<script ${LIVE_RELOAD_SCRIPT_ATTR}>`, "")
      .replace("</script>", "");

    const runScript = new Function("window", "document", "EventSource", scriptCode);
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

describe("stripLiveReloadScript", () => {
  it("removes only the injected script and never crosses into neighboring scripts", () => {
    const html =
      `<script>window.a = 1</script>` +
      getLiveReloadScript("/sub/bascik-live-reload").trim() +
      `<script>window.b = 2</script>`;
    expect(stripLiveReloadScript(html)).toBe(`<script>window.a = 1</script><script>window.b = 2</script>`);
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
    for (const tail of [`ipt ${LIVE_RELOAD_SCRIPT_ATTR}>x()</script>`, "ipt>alert(1)</script>"]) {
      const html = `<p>a</p><scr${inner}${tail}<p>b</p>`;
      expect(expectOnlyLiveReloadRemoved(html)).toBe(html);
    }
  });

  it("removes a real live-reload script after a text < without joining the < to what follows", () => {
    const html = `<p>a</p><${getLiveReloadScript().trim()}script>alert(1)</script>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe("<p>a</p><<!---->script>alert(1)</script>");
  });

  it("ignores the attribute name inside another attribute's value", () => {
    const html = `<script data-note=" ${LIVE_RELOAD_SCRIPT_ATTR}">user()</script>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe(html);
  });

  it("removes live-reload scripts in <template> and SVG too, where they could still run", () => {
    const html =
      `<template><script ${LIVE_RELOAD_SCRIPT_ATTR}>t()</script></template>` +
      `<svg><script ${LIVE_RELOAD_SCRIPT_ATTR}>s()</script></svg><p>x</p>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe("<template></template><svg></svg><p>x</p>");
  });

  it("removes the whole script when its body escapes a nested <script>", () => {
    const html = `<p>a</p><script ${LIVE_RELOAD_SCRIPT_ATTR}><!--<script>x()</script>y()--></script><p>b</p>`;
    expect(expectOnlyLiveReloadRemoved(html)).toBe("<p>a</p><p>b</p>");
  });

  it("stays linear on deeply nested look-alikes", () => {
    let html = getLiveReloadScript().trim();
    for (let i = 0; i < 1000; i++) html = `<scr${html}ipt ${LIVE_RELOAD_SCRIPT_ATTR}>x${i}()</script>`;
    const started = performance.now();
    stripLiveReloadScript(html);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("removes exactly the live-reload scripts and nothing else, on random malformed markup", () => {
    const fragment = fc.constantFrom(
      `<script ${LIVE_RELOAD_SCRIPT_ATTR}>lr()</script>`, `<script ${LIVE_RELOAD_SCRIPT_ATTR}>`, "<script>keep()</script>",
      "<scr", `ipt ${LIVE_RELOAD_SCRIPT_ATTR}>`, "ipt>", "x()", "</script>", "<!--", "-->", "<!-- c -->", "<", ">",
      '"', "&am", "p;", "<p>", "</p>", '<div title="', '">', "<template>", "</template>", "<textarea>",
      "</textarea>", "<svg>", "</svg>", "<foreignObject>", "<noscript>", "</noscript>", "<![CDATA[", "]]>",
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
    const body = getLiveReloadScript().trim().replace(/<\/script>$/, "");
    for (const endTag of ["</script >", "</SCRIPT>", "</script\t\n foo>", "</script/>"]) {
      expect(stripLiveReloadScript(`<p>a</p>${body}${endTag}<p>b</p>`)).toBe("<p>a</p><p>b</p>");
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
    expect(html).toContain("Dev server offline. Will reconnect automatically when server restarts.");
  });
});
