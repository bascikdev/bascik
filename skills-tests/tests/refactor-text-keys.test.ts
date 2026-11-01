// Unit tests for the whitespace-insensitive text keys the bascik-refactor parity checks share: keyMatch and
// byKeyMatch in lib/checks.mjs, and each check's comparison of production's keys with the target's. The browser half
// (keyText reading rendered text only, and each check run on React markup against the same page formatted by Prettier)
// is in refactor-text-keys.integration.test.ts.
//
// Why: React writes no whitespace between elements and formatted HTML has newlines there, so one element was keyed
// "FOOTER:v5.0.1Copyright" on one side and "FOOTER:v5.0.1 Copyright" on the other, and every check reported it as
// missing on the target.
import { describe, expect, it } from "vitest";
import {
  byKeyMatch,
  capKeyText,
  keyMatch,
} from "../../skills/bascik-refactor/scripts/lib/checks.mjs";
import {
  diffPresence,
  presenceKey,
} from "../../skills/bascik-refactor/scripts/presence-by-route.mjs";
import { diffOverlaps } from "../../skills/bascik-refactor/scripts/overlap-diff.mjs";
import { diffSpacing } from "../../skills/bascik-refactor/scripts/spacing-diff.mjs";
import { diffAlignment } from "../../skills/bascik-refactor/scripts/alignment-diff.mjs";
import { diffTextStyles } from "../../skills/bascik-refactor/scripts/text-style-diff.mjs";
import { diffItemStates } from "../../skills/bascik-refactor/scripts/state-capture.mjs";
import {
  diffEffects,
  matchAnchor,
} from "../../skills/bascik-refactor/scripts/interaction-crawl.mjs";
import {
  applyCorrections,
  diffDefects,
} from "../../skills/bascik-refactor/scripts/production-defects.mjs";
import { diffGeometry } from "../../skills/bascik-refactor/scripts/geometry-diff.mjs";
import { diffHooks } from "../../skills/bascik-refactor/scripts/testid-carryover.mjs";

/** The same element as React writes it and as Prettier formats it. */
const REACT = "FOOTER:Milk frother v5.0.1Copyright 2026";
const FORMATTED = "FOOTER:Milk frother v5.0.1 Copyright 2026";
/** A real text change. */
const CHANGED = "FOOTER:Milk frother v5.0.1 Copyright 2025";

describe("keyMatch and byKeyMatch", () => {
  it("remove every whitespace character, so only markup formatting is ignored", () => {
    expect(keyMatch(REACT)).toBe(keyMatch(FORMATTED));
    expect(keyMatch("H1:MILK\n  FROTHER\t")).toBe("H1:MILKFROTHER");
    expect(keyMatch(CHANGED)).not.toBe(keyMatch(FORMATTED));
  });

  it("read a missing key as empty instead of throwing", () => {
    expect(keyMatch(undefined)).toBe("");
    expect(keyMatch(null)).toBe("");
  });

  it("look a key up by keyMatch in an object or in pairs, first entry wins", () => {
    const lookup = byKeyMatch({ [REACT]: 1, "P:Other": 2 });
    expect(lookup.get(FORMATTED)).toBe(1);
    expect(lookup.has(CHANGED)).toBe(false);
    expect(
      byKeyMatch([
        [REACT, "a"],
        [FORMATTED, "b"],
      ]).get(REACT),
    ).toBe("a");
    expect(byKeyMatch(undefined).get(REACT)).toBeUndefined();
  });

  it("capKeyText cuts after the same number of visible characters, whatever the whitespace", () => {
    const tight = "Silkymilkfoam".repeat(10);
    const spaced = "Silky milk foam ".repeat(10);
    expect(keyMatch(capKeyText(tight, 60))).toBe(
      keyMatch(capKeyText(spaced, 60)),
    );
    expect(keyMatch(capKeyText(spaced, 60))).toHaveLength(60);
    expect(capKeyText(" short  text ", 60)).toBe("short text");
  });
});

describe("each check matches keys that differ only in whitespace, and still reports a real change", () => {
  it("presence-by-route", () => {
    const snap = (key: string) => [
      {
        route: "/",
        width: 1280,
        state: "fresh",
        items: [{ key, reasons: ["fixed"], dock: "top-center" }],
      },
    ];
    expect(diffPresence(snap(REACT), snap(FORMATTED))).toEqual([]);
    expect(
      diffPresence(snap(REACT), snap(CHANGED)).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["missing", "extra"]);
    // A docked layer that matches only once whitespace is removed is still compared for placement.
    const moved = snap(FORMATTED);
    moved[0].items[0].dock = "bottom-center";
    expect(
      diffPresence(snap(REACT), moved).map((f: { kind: string }) => f.kind),
    ).toEqual(["placement"]);
    // The text part of a key is cut at the same visible character on both sides.
    const long = (text: string) =>
      presenceKey({ tag: "DIV", role: null, name: "", text });
    expect(keyMatch(long("Free shipping ".repeat(8)))).toBe(
      keyMatch(long("Freeshipping".repeat(8))),
    );
  });

  it("overlap-diff", () => {
    const pair = (a: string) => [
      {
        a,
        b: "P:Café-style foam",
        dx: 0,
        dy: 0,
        wRatio: 1,
        hRatio: 1,
      },
    ];
    expect(diffOverlaps(pair(REACT), pair(FORMATTED))).toEqual([]);
    expect(
      diffOverlaps(pair(REACT), pair(CHANGED)).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["missing-overlap"]);
  });

  it("spacing-diff", () => {
    const sections = (key: string, child: string) => [
      {
        key,
        children: [{ key: child, offset: 24, gap: null }],
        height: 80,
        gap: 0,
      },
    ];
    expect(
      diffSpacing(
        sections(REACT, "P:Copyright 2026"),
        sections(FORMATTED, "P:Copyright\n 2026"),
      ),
    ).toEqual([]);
    expect(
      diffSpacing(
        sections(REACT, "P:Copyright 2026"),
        sections(CHANGED, "P:Copyright 2026"),
      ).map((f: { kind: string }) => f.kind),
    ).toEqual(["missing-section"]);
    expect(
      diffSpacing(
        sections(REACT, "P:Copyright 2026"),
        sections(FORMATTED, "P:Copyright 2025"),
      ).map((f: { kind: string }) => f.kind),
    ).toEqual(["missing"]);
  });

  it("alignment-diff", () => {
    const node = { textAlign: "left", lines: 1, left: 0, right: 0 };
    const at = (key: string) => [
      { width: 1280, height: 800, nodes: { [key]: node } },
    ];
    expect(diffAlignment(at(REACT), at(FORMATTED))).toEqual([]);
    expect(
      diffAlignment(at(REACT), at(CHANGED)).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["missing"]);
  });

  it("text-style-diff", () => {
    const styles = (key: string) => ({
      [key]: { rest: { color: "rgb(0, 0, 0)" } },
    });
    expect(diffTextStyles(styles(REACT), styles(FORMATTED))).toEqual([]);
    expect(
      diffTextStyles(styles(REACT), styles(CHANGED)).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["missing"]);
  });

  it("state-capture item states", () => {
    const states = (key: string, color: string) => ({
      [key]: { hover: { color }, "focus-visible": { color } },
    });
    expect(
      diffItemStates("Menu", states(REACT, "red"), states(FORMATTED, "red")),
    ).toEqual([]);
    expect(
      diffItemStates("Menu", states(REACT, "red"), states(FORMATTED, "blue")),
    ).toHaveLength(2);
  });

  it("interaction-crawl anchors and effects", () => {
    const anchor = (text: string) => ({
      tag: "DIV",
      role: null,
      name: "",
      text,
      href: null,
      testId: null,
    });
    expect(matchAnchor(anchor("MILKFROTHER"), [anchor("MILK FROTHER")])).toBe(
      0,
    );
    expect(matchAnchor(anchor("MILKFROTHER"), [anchor("MILK FROSTER")])).toBe(
      -1,
    );
    const effect = (key: string) => ({
      scrollDelta: 600,
      scrollTarget: key,
      hash: "",
      url: "/",
      changed: [],
      shown: [key],
      focused: key,
    });
    const item = (key: string) => ({
      anchor: anchor("Open"),
      effect: effect(key),
    });
    expect(diffEffects([item(REACT)], [item(FORMATTED)])).toEqual([]);
    expect(
      diffEffects([item(REACT)], [item(CHANGED)]).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual([
      "different-effect",
      "missing-effect",
      "different-effect",
      "different-effect",
    ]);
  });

  it("production-defects", () => {
    const defect = (key: string) => ({
      kind: "icon-misaligned",
      route: "/",
      width: 1280,
      key,
      message: "misaligned",
    });
    expect(
      diffDefects([defect(REACT)], [defect(FORMATTED)]).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["copied-defect"]);
    expect(
      diffDefects([defect(REACT)], [defect(CHANGED)]).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["target-defect"]);
    const parity = {
      check: "spacing-diff",
      kind: "height",
      route: "/",
      width: 1280,
      key: FORMATTED,
      message: "taller",
    };
    expect(applyCorrections([parity], [defect(REACT)]).corrected).toEqual([
      parity,
    ]);
    expect(applyCorrections([parity], [defect(CHANGED)]).kept).toEqual([
      parity,
    ]);
  });

  it("geometry-diff", () => {
    const box = { x: 0, y: 0, w: 100, h: 20 };
    const nodes = (key: string) => ({ [key]: box });
    expect(diffGeometry(nodes(REACT), nodes(FORMATTED)).ok).toBe(true);
    const changed = diffGeometry(nodes(REACT), nodes(CHANGED));
    expect(changed.missing).toEqual([REACT]);
    expect(changed.extra).toEqual([CHANGED]);
  });

  it("testid-carryover", () => {
    const hook = (text: string) => ({
      attr: "data-testid",
      value: "site-footer",
      anchor: { tag: "FOOTER", role: "contentinfo", name: "", text },
    });
    expect(
      diffHooks([hook("v5.0.1Copyright")], [hook("v5.0.1 Copyright")]),
    ).toEqual([]);
    expect(
      diffHooks([hook("v5.0.1Copyright")], [hook("v5.0.2 Copyright")]).map(
        (f: { kind: string }) => f.kind,
      ),
    ).toEqual(["moved"]);
  });
});
