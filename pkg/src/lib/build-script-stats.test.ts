import { describe, expect, it } from "vitest";
import {
  addBuildScriptStats,
  createBuildScriptStats,
  formatBuildScriptSummary,
  formatPageBuildScriptStats,
} from "./build-script-stats.ts";

describe("build-script-stats", () => {
  it("starts at zero and sums in place", () => {
    const total = createBuildScriptStats();
    expect(total).toEqual({ ran: 0, cached: 0, childMs: 0 });
    addBuildScriptStats(total, { ran: 2, cached: 3, childMs: 40 });
    addBuildScriptStats(total, { ran: 1, cached: 0, childMs: 10.5 });
    expect(total).toEqual({ ran: 3, cached: 3, childMs: 50.5 });
  });

  it("adds nothing to a page line when no script ran, so sites without build scripts print the same line", () => {
    expect(formatPageBuildScriptStats(createBuildScriptStats())).toBe("");
    expect(formatPageBuildScriptStats({ ran: 0, cached: 52, childMs: 0 })).toBe(
      "",
    );
  });

  it("names the child time and the scripts that ran on a page line, with cache hits only when there are any", () => {
    expect(
      formatPageBuildScriptStats({ ran: 52, cached: 0, childMs: 5100 }),
    ).toBe(" (+5.1s in 52 build scripts)");
    expect(
      formatPageBuildScriptStats({ ran: 1, cached: 23, childMs: 48 }),
    ).toBe(" (+48ms in 1 build script, 23 cached)");
  });

  it("adds the ran and cached counts to the summary whenever the site has build scripts", () => {
    expect(formatBuildScriptSummary(createBuildScriptStats())).toBe("");
    expect(formatBuildScriptSummary({ ran: 969, cached: 0, childMs: 0 })).toBe(
      " (969 build scripts ran, 0 from cache)",
    );
    expect(formatBuildScriptSummary({ ran: 0, cached: 969, childMs: 0 })).toBe(
      " (0 build scripts ran, 969 from cache)",
    );
    expect(formatBuildScriptSummary({ ran: 1, cached: 2, childMs: 30 })).toBe(
      " (1 build script ran, 2 from cache)",
    );
  });
});
