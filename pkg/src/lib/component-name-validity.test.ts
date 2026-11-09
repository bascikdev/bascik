import { describe, expect, it } from "vitest";
import {
  invalidComponentNameMessage,
  suggestValidComponentName,
} from "./component-name-validity.ts";

// Finding 144: a component file named "my widget.html" got the hyphen hint
// "my-my widget", a name no tag can spell.
describe("component names a tag cannot spell (finding 144)", () => {
  it.each([
    ["my widget", "my-widget"],
    ["my  big widget", "my-big-widget"],
    ["price(eur)", "price-eur"],
    ["2col", "my-2col"],
    ["-card", "my-card"],
    ["hero@home", "hero-home"],
    ["wide", "my-wide"],
  ])("suggests %s -> %s", (name, suggestion) => {
    expect(suggestValidComponentName(name)).toBe(suggestion);
  });

  it.each(["my widget", "price(eur)", "2col", "-card", "a>b"])(
    "rejects %j with the file name and a real suggestion",
    (name) => {
      const message = invalidComponentNameMessage(
        name,
        `src/components/${name}.html`,
      );
      expect(message).toContain(`src/components/${name}.html`);
      expect(message).toContain(`${suggestValidComponentName(name)}.html`);
      expect(message).not.toMatch(/my-my/);
    },
  );

  it.each(["my-card", "card", "nav", "x-ü-widget", "a.b-c", "my_card-x"])(
    "accepts %s (hyphen and native-name advice is separate)",
    (name) => {
      expect(invalidComponentNameMessage(name, `${name}.html`)).toBeUndefined();
    },
  );
});
