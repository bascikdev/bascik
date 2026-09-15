import { describe, it, expect, vi } from "vitest";
import {
  LIVE_RELOAD_SCRIPT,
  LIVE_RELOAD_SCRIPT_ATTR,
  getLiveReloadScript,
  stripLiveReloadScript,
} from "./live-reload.ts";
import { BOOT_PAGE_HTML } from "./boot-page.ts";

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
