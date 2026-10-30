/**
 * Linear-time checks for `shared-name-group` (name-groups.test.ts has the
 * rule's behavior). CPU-growth sampling takes minutes on Windows, so these
 * run in the `linear-time` Vitest project, not `unit`.
 */
import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "./project.js";
import { findNameGroups, countInstancesOnPages } from "./name-groups.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const COMPONENTS = "/site/src/components";
const PAGES = "/site/src/pages";

const RADIOS = [
  "<fieldset>",
  "  <legend>Size</legend>",
  '  <label><input type="radio" name="size" value="s"> Small</label>',
  '  <label><input type="radio" name="size" value="l"> Large</label>',
  "</fieldset>",
].join("\n");

/** A snapshot with one component `x-y` holding a radio group, used `n` times on one page. */
const pageSnapshot = (n: number): ProjectSnapshot => {
  const file = `${COMPONENTS}/x-y.html`;
  return {
    projectRoot: "/site",
    componentRoots: [COMPONENTS],
    apiRoot: "/site/src/api",
    componentMap: new Map([["x-y", file]]),
    componentMetadata: new Map(),
    importRoot: "/site/src",
    pagesRoot: PAGES,
    htmlUsageByFile: new Map([
      [`${PAGES}/index.html`, "<x-y></x-y>".repeat(n)],
    ]),
    componentSourceByFile: new Map([[file, RADIOS]]),
  };
};

describe("shared-name-group: linear time", () => {
  it(
    "scans markup and counts usages in linear time",
    () => {
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      const groupsOf = (n: number) => {
        const html =
          '<input type="radio" name="a">'.repeat(n) + "<form>".repeat(n);
        return () => findNameGroups(html);
      };
      expect(growthOf(groupsOf(5_000), groupsOf(20_000))).toBeLessThan(8);
      const pageOf = (n: number) => {
        const snapshot = pageSnapshot(n);
        return () => countInstancesOnPages("x-y", snapshot, []);
      };
      expect(growthOf(pageOf(5_000), pageOf(20_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
