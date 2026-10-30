import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  barLabel,
  renderBuildBreakdown,
  scriptName,
  segmentsFor,
} from "./build-breakdown.ts";
import type { BuildRunTimings, BuildTimings } from "./build-stats.ts";

const run = (wallSeconds: number, pagesSeconds: number): BuildRunTimings => ({
  wallSeconds,
  totalSeconds: wallSeconds - 0.2,
  startupSeconds: 0.2,
  preScriptsSeconds: 0.1,
  pagesSeconds,
  postScriptsSeconds: 0.7,
  otherSeconds: 0,
  execScripts: [
    {
      script: "scripts/publish-heading-anchors.ts",
      phase: "pre",
      seconds: 0.1,
    },
    {
      script: "scripts/generate-og-images.ts",
      phase: "parallel",
      seconds: 0.72,
    },
    {
      script: "scripts/generate-press-kit.ts",
      phase: "parallel",
      seconds: 0.8,
    },
    { script: "scripts/generate-csp-meta.ts", phase: "post", seconds: 0.7 },
  ],
  pageMedianMs: 30,
  slowestPage: { path: "pages/cli.html", ms: 613 },
});

const timings: BuildTimings = {
  measuredOn: "2026-10-14",
  bascikVersion: "1.0.0",
  nodeVersion: "24.0.0",
  machine: "Test <CPU>, 8 cores",
  pages: 100,
  buildScripts: 971,
  cold: run(21, 19.8),
  warm: run(5, 3.8),
};

describe("build-breakdown", () => {
  let root: string;
  let timingsPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "build-breakdown-"));
    timingsPath = join(root, "build-timings.json");
    await writeFile(timingsPath, JSON.stringify(timings));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("names a script by its file, without folder or extension", () => {
    expect(scriptName("scripts/generate-og-images.ts")).toBe(
      "generate-og-images",
    );
    expect(scriptName("generate.mjs")).toBe("generate");
  });

  it("drops phases that took no time and keeps the others in the order they happen", () => {
    const segments = segmentsFor(timings.cold, "cold", {
      pages: 100,
      buildScripts: 971,
    });
    expect(segments.map((segment) => segment.id)).toEqual([
      "startup",
      "pre",
      "pages",
      "post",
    ]);
    expect(segments[2].detail).toContain("971 build scripts");
    expect(
      segmentsFor(timings.warm, "warm", { pages: 100, buildScripts: 971 })[2]
        .detail,
    ).toContain("cache");
  });

  it("summarizes a bar in one sentence for assistive technology", () => {
    const segments = segmentsFor(timings.cold, "cold", {
      pages: 100,
      buildScripts: 971,
    });
    expect(barLabel("Cold build", timings.cold, segments)).toBe(
      "Cold build, 21s in total: start-up 200ms, pre scripts 100ms, pages 19.8s, post scripts 700ms",
    );
  });

  it("renders both builds to one scale so the warm bar is shorter", async () => {
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html).toContain("Cold build");
    expect(html).toContain("Warm build");
    const widths = [
      ...html.matchAll(/class="bb-bar"[^>]*style="width:([\d.]+)%"/g),
    ].map((match) => Number(match[1]));
    expect(widths).toEqual([100, 23.8]);
  });

  it("shows the live counts, and the measured build script count", async () => {
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html).toContain(
      '<span class="bb-fact-value">102</span><span class="bb-fact-label">pages</span>',
    );
    expect(html).toContain(
      '<span class="bb-fact-value">41</span><span class="bb-fact-label">components</span>',
    );
    expect(html).toContain(
      '<span class="bb-fact-value">971</span><span class="bb-fact-label">build scripts run</span>',
    );
  });

  it("highlights the measured single-page and dev edit latencies, not whole-build averages", async () => {
    await writeFile(
      timingsPath,
      JSON.stringify({
        ...timings,
        oneWorker: {
          pageMedianMs: 20,
          slowestPage: { path: "pages/components.html", ms: 114 },
        },
        devContentEdit: {
          medianDiskMs: 570.45,
          samples: 3,
          measuredOn: "2026-10-30",
        },
      }),
    );
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html).toContain(
      '<span class="bb-fact-value">20ms</span><span class="bb-fact-label">median page, warm, one worker</span>',
    );
    expect(html).toContain(
      '<span class="bb-fact-value">570ms</span><span class="bb-fact-label">dev Markdown edit → updated page on disk</span>',
    );
    expect(html).toContain("median of 3 warm-cache saves");
    expect(html).toContain("not browser reload");
    expect(html).not.toContain("per page, warm");
  });

  it("lists the parallel exec scripts longest first, and says they add no time", async () => {
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html.indexOf("generate-press-kit")).toBeLessThan(
      html.indexOf("generate-og-images"),
    );
    expect(html).toContain("run in parallel with the pages");
    expect(html).toContain("the longest is 800ms");
  });

  it("renders a pointer to the measuring command, not an error, when the timings are missing or old", async () => {
    const missing = await renderBuildBreakdown({
      timingsPath: join(root, "missing.json"),
      pages: 1,
      components: 1,
    });
    expect(missing).toContain("yarn docs:measure-build");
    await writeFile(
      timingsPath,
      JSON.stringify({ measuredOn: "2026-01-01", pages: 80 }),
    );
    expect(
      await renderBuildBreakdown({ timingsPath, pages: 1, components: 1 }),
    ).toContain("have not been measured");
  });

  it("says the worker-mode per-page figures include contention when no one-worker run was measured", async () => {
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html).toContain(
      "Median page 30ms, slowest cli.html at 613ms, warm, as printed by a build on every core",
    );
    expect(html).toContain("waiting for a core");
  });

  it("quotes the one-worker per-page figures when they were measured, and says why", async () => {
    await writeFile(
      timingsPath,
      JSON.stringify({
        ...timings,
        oneWorker: {
          pageMedianMs: 20,
          slowestPage: { path: "pages/components.html", ms: 114 },
        },
      }),
    );
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html).toContain(
      "Median page 20ms, slowest components.html at 114ms, warm, on one worker thread",
    );
    expect(html).not.toContain("613ms");
  });

  it("escapes the measured machine name and states how to re-measure", async () => {
    const html = await renderBuildBreakdown({
      timingsPath,
      pages: 102,
      components: 41,
    });
    expect(html).toContain("Test &lt;CPU&gt;, 8 cores");
    expect(html).not.toContain("<CPU>");
    expect(html).toContain("yarn docs:measure-build");
  });
});
