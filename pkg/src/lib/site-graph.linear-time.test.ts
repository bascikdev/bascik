import { describe, it, expect } from "vitest";
import { splitDistPageIntoSegments } from "./site-graph.ts";
import {
  LINEAR_TIME_TIMEOUT_MS,
  expectLinearTime,
} from "./linear-time.test-helper.ts";

describe("splitDistPageIntoSegments", () => {
  it(
    "stays linear on many placeholders and many unterminated placeholder open tags",
    () => {
      const many = (n: number) =>
        '<p>a</p><script type="text/bascik-server" data-bascik-server-id="s"></script>'.repeat(
          n,
        );
      const unterminated = (n: number) =>
        '<script type="text/bascik-server" data-bascik-server-id="s">'.repeat(
          n,
        );
      expect(splitDistPageIntoSegments(many(50_000)).scriptIds).toHaveLength(
        50_000,
      );
      expect(splitDistPageIntoSegments(unterminated(50_000)).scriptIds).toEqual(
        [],
      );
      for (const [label, input] of [
        ["placeholders", many],
        ["unterminated open tags", unterminated],
      ] as const)
        expectLinearTime(input, 50_000, splitDistPageIntoSegments, { label });
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "stays linear on long whitespace runs and repeated unterminated end tags",
    () => {
      const open =
        '<script type="text/bascik-server" data-bascik-server-id="s">';
      const cases = [
        [(n: number) => `${open}${" ".repeat(n)}x`, 200_000, []],
        [(n: number) => `${open}${"</script\t".repeat(n)}`, 50_000, []],
        [(n: number) => `${open}${" ".repeat(n)}</script>`, 200_000, ["s"]],
      ] as const;
      for (const [input, size, ids] of cases) {
        const label = input(2).slice(open.length);
        expect(splitDistPageIntoSegments(input(size)).scriptIds, label).toEqual(
          ids,
        );
        expectLinearTime(input, size, splitDistPageIntoSegments, { label });
      }
    },
    LINEAR_TIME_TIMEOUT_MS,
  );

  it(
    "stays fast on many repeated type attributes in an unterminated tag",
    () => {
      const html = (n: number) =>
        `<script ${'type="text/bascik-server"'.repeat(n)}`;
      expect(splitDistPageIntoSegments(html(20_000)).scriptIds).toEqual([]);
      expectLinearTime(html, 20_000, splitDistPageIntoSegments);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
