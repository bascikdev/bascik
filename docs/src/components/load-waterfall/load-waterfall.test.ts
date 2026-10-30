import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("load-waterfall component", () => {
  const dir = join(process.cwd(), "src/components/load-waterfall");
  const read = () => readFile(join(dir, "load-waterfall.html"), "utf8");

  it("compares an SPA with every way Bascik serves a page: static, server, and stream", async () => {
    const html = await read();

    for (const lane of [
      "Framework SPA",
      "Static page",
      "Server script",
      "Stream script",
    ])
      expect(html, lane).toContain(`aria-label="${lane}"`);
    expect(html).toContain('data-testid="load-waterfall"');
  });

  it("marks when content is visible in each lane, after the shell paints when streaming", async () => {
    const html = await read();
    const lanes = html.split('<div class="lane">').slice(1);

    expect(lanes).toHaveLength(4);
    for (const lane of lanes)
      expect(lane.match(/class="row row-seen"/g)).toHaveLength(1);
    const stream = lanes[3];
    expect(stream.indexOf("Paint the shell")).toBeLessThan(
      stream.indexOf("Content visible"),
    );
    expect(stream.indexOf("Content visible")).toBeLessThan(
      stream.indexOf("Section arrives"),
    );
  });

  it("keeps every bar inside the 18-column track (4.5 round trips)", async () => {
    const html = await read();
    const spans = [...html.matchAll(/grid-column: (\d+) \/ (\d+)/g)];

    expect(spans.length).toBeGreaterThan(0);
    for (const [, start, end] of spans) {
      expect(Number(start)).toBeGreaterThanOrEqual(1);
      expect(Number(end)).toBeGreaterThan(Number(start));
      expect(Number(end)).toBeLessThanOrEqual(19);
    }
  });
});
