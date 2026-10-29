import { describe, expect, it } from "vitest";
import {
  lostPlaceholderError,
  lostPlaceholderMessages,
  placeholderIdsInHtml,
} from "./lost-placeholders.ts";

const id = (page: string, ordinal: number) =>
  `server_script_${Buffer.from(`${page}::${ordinal}`).toString("hex")}`;

describe("placeholderIdsInHtml", () => {
  it("finds server and stream placeholders, in any quoting, case or attribute order", () => {
    const html =
      `<p>a</p><script type="text/bascik-server" data-bascik-server-id="${id("pages/a.html", 0)}"></script>` +
      `<SCRIPT data-bascik-server-id=${id("pages/a.html", 1)} TYPE='text/bascik-server' data-bascik-stream></SCRIPT>`;
    expect([...placeholderIdsInHtml(html)].sort()).toEqual(
      [id("pages/a.html", 0), id("pages/a.html", 1)].sort(),
    );
  });

  it("does not count a placeholder whose type was dropped, or an id in prose", () => {
    const html =
      `<script data-bascik-server-id="${id("pages/a.html", 0)}"></script>` +
      `<p>data-bascik-server-id="${id("pages/a.html", 1)}"</p>`;
    expect(placeholderIdsInHtml(html).size).toBe(0);
  });
});

describe("lostPlaceholderMessages", () => {
  const scripts = {
    [id("pages/a.html", 0)]: { mode: "server" as const },
    [id("pages/b.html", 0)]: { mode: "server" as const },
    [id("pages/b.html", 1)]: { mode: "stream" as const },
    [id("pages/gone.html", 0)]: { mode: "server" as const },
  };

  it("names each page, the count, and the tag to paste back (stream marker included)", () => {
    const found = new Map([
      ["pages/a.html", new Set<string>()],
      ["pages/b.html", new Set([id("pages/b.html", 0)])],
    ]);
    expect(
      lostPlaceholderMessages(found, scripts, "dist", ".bascik/dist"),
    ).toEqual([
      `dist/a.html: .bascik/dist/server-scripts.json holds 1 server script for this page, but the page has no placeholder for it ` +
        `(\`<script type="text/bascik-server" data-bascik-server-id="${id("pages/a.html", 0)}"></script>\`)`,
      `dist/b.html: .bascik/dist/server-scripts.json holds 2 server scripts for this page, but 1 of their placeholders is gone ` +
        `(\`<script type="text/bascik-server" data-bascik-server-id="${id("pages/b.html", 1)}" data-bascik-stream></script>\`)`,
    ]);
  });

  it("passes pages that kept every placeholder, and skips a page gone from the output", () => {
    const found = new Map([
      ["pages/a.html", new Set([id("pages/a.html", 0)])],
      ["pages/b.html", new Set([id("pages/b.html", 0), id("pages/b.html", 1)])],
    ]);
    expect(
      lostPlaceholderMessages(found, scripts, "dist", ".bascik/dist"),
    ).toEqual([]);
  });
});

describe("lostPlaceholderError", () => {
  it("names at most five pages and counts the rest", () => {
    const lost = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    const text = lostPlaceholderError(
      "--build: lead.",
      lost,
      "A `post` exec script",
    );
    expect(text).toMatch(
      /^\[bascik\] --build: lead\. p1; p2; p3; p4; p5; and 2 more pages\. A `post` exec script removed or rewrote the placeholder/,
    );
  });
});
