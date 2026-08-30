import { describe, it, expect } from "vitest";
import { LIVE_RELOAD_SCRIPT } from "./live-reload.ts";
import { BOOT_PAGE_HTML } from "./boot-page.ts";

describe("LIVE_RELOAD_SCRIPT", () => {
  it("contains script tag wrapper", () => {
    expect(LIVE_RELOAD_SCRIPT).toContain("<script>");
    expect(LIVE_RELOAD_SCRIPT).toContain("</script>");
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
