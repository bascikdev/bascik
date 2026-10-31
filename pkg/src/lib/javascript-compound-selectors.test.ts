/**
 * DOM query strings in scripts are rewritten token by token. Every `.class` and `#id` token
 * of a compound selector must be rewritten, or the selector matches nothing once the markup
 * and CSS carry the scoped names (review finding F039).
 */
import { describe, expect, it, vi } from "vitest";
import { prefixElementAttribute } from "./javascript.ts";
import type { BascikComponent } from "./types.ts";

vi.mock("./config.js", () => ({
  BascikConfig: {
    minify: { identifiers: false },
    scoping: {
      attributes: { class: true, id: true, name: true },
      deduplicateCss: true,
      preserve: ["code"],
    },
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
  },
}));

const css = ".card{} .active{} .card.active{} .btn{} .primary{} .open{}";
const markup =
  '<div id="panel" class="card active open"><button class="btn primary"></button></div>';

const scopeClasses = (script: string): string =>
  prefixElementAttribute(
    {
      name: "my-comp",
      fileContent: `${markup}<script>${script}</script>`,
      cssFileContent: css,
    } satisfies BascikComponent,
    "class",
    "t1",
  ).fileContent!;

const scopeIds = (script: string): string =>
  prefixElementAttribute(
    { name: "my-comp", fileContent: `${markup}<script>${script}</script>` },
    "id",
    "t1",
  ).fileContent!;

const c = (name: string): string => `bascik__my-comp__${name}`;
const id = (name: string): string => `bascik__my-comp__t1__${name}`;

describe("rewriteSelectorCalls – compound class selectors", () => {
  it.each([
    [
      'root.querySelector(".card.active")',
      `root.querySelector(".${c("card")}.${c("active")}")`,
    ],
    [
      'root.querySelector("button.btn.primary")',
      `root.querySelector("button.${c("btn")}.${c("primary")}")`,
    ],
    [
      'root.querySelectorAll("div.card")',
      `root.querySelectorAll("div.${c("card")}")`,
    ],
    ['el.closest("div.card")', `el.closest("div.${c("card")}")`],
    ['el.matches(".card.btn")', `el.matches(".${c("card")}.${c("btn")}")`],
    [
      'root.querySelector(".card.active > button.btn:not(.primary)")',
      `root.querySelector(".${c("card")}.${c("active")} > button.${c("btn")}:not(.${c("primary")})")`,
    ],
    [
      'root.querySelector("#panel.open")',
      `root.querySelector("#panel.${c("open")}")`,
    ],
  ])("rewrites every class token: %s", (script, expected) => {
    expect(scopeClasses(script)).toContain(expected);
  });

  it("leaves global classes and unknown tokens in a compound as written", () => {
    expect(scopeClasses('root.querySelector(".card.is-global")')).toContain(
      `root.querySelector(".${c("card")}.is-global")`,
    );
  });

  it("does not read a dot inside an attribute selector value as a class", () => {
    expect(
      scopeClasses('root.querySelector("a[data-x=card.active].btn")'),
    ).toContain(`root.querySelector("a[data-x=card.active].${c("btn")}")`);
  });

  it("does not read an escaped dot as a class", () => {
    expect(scopeClasses('root.querySelector(".x\\\\.card")')).toContain(
      'root.querySelector(".x\\\\.card")',
    );
  });
});

describe("rewriteSelectorCalls – compound id selectors", () => {
  it.each([
    [
      'root.querySelector("div#panel")',
      `root.querySelector("div#${id("panel")}")`,
    ],
    [
      'root.querySelector("#panel.open")',
      `root.querySelector("#${id("panel")}.open")`,
    ],
    [
      'root.querySelector(".card#panel")',
      `root.querySelector(".card#${id("panel")}")`,
    ],
  ])("rewrites the id token: %s", (script, expected) => {
    expect(scopeIds(script)).toContain(expected);
  });
});
