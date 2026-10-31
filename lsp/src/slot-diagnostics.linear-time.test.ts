/**
 * Linear-time check for the slot diagnostics in createDiagnostics
 * (slot-outside-component, undeclared-slot). Each data-bascik-slot tag needs
 * its nearest enclosing component; finding it by rescanning the text before
 * every slot tag was quadratic in the number of slots. CPU-growth sampling
 * takes minutes on Windows, so this runs in the `linear-time` Vitest project.
 */
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { createDiagnostics } from "./analyzer.js";
import type { ProjectSnapshot } from "./project.js";
import { LINEAR_TIME_TIMEOUT_MS, growthOf } from "./linear-time.test.util.js";

const snapshot: ProjectSnapshot = {
  projectRoot: "/site",
  componentRoots: ["/site/src/components"],
  componentMap: new Map([["demo-card", "/site/src/components/demo-card.html"]]),
  componentMetadata: new Map([
    [
      "demo-card",
      {
        props: [],
        slots: [{ name: "header" }],
        hasStyles: false,
        hasScripts: false,
        diagnostics: [],
      },
    ],
  ]),
  importRoot: "/site/src",
  htmlUsageByFile: new Map(),
};

const pageOf = (n: number) => {
  const text =
    '<demo-card><h2 data-bascik-slot="header">Milk frother</h2><p>Foams in 30 seconds.</p></demo-card>\n'.repeat(
      n,
    );
  const document = TextDocument.create(
    "file:///site/src/pages/index.html",
    "html",
    1,
    text,
  );
  return () =>
    createDiagnostics(document, "/site/src/pages/index.html", snapshot);
};

describe("slot diagnostics: linear time", () => {
  it(
    "finds each slot's parent component in one pass over the page",
    () => {
      // Tick-aware CPU-time growth: see linear-time.test.util.ts.
      expect(growthOf(pageOf(500), pageOf(2_000))).toBeLessThan(8);
    },
    LINEAR_TIME_TIMEOUT_MS,
  );
});
