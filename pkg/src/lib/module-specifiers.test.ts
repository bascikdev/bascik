import { describe, expect, it } from "vitest";
import { findModuleSpecifiers } from "./module-specifiers.ts";

describe("findModuleSpecifiers", () => {
  it.each([
    `if (ready) /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
    `{ markReady(); } /import\\(['"]\\.\\/fake\\.ts['"]\\)/.test(source);`,
    `if (ready) /import('fake-package')/.test(source);`,
    `{ markReady(); } /import('fake-package')/.test(source);`,
  ])("ignores import-like text in a regex after a statement boundary", (source) => {
    expect(findModuleSpecifiers(source)).toEqual([]);
  });
});