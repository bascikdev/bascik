import { test, expect } from "vitest";
import { prefixElementAttribute } from "./javascript.js";

test("prefixElementAttribute with class in other attribute", () => {
  const comp = {
    name: "MyComp",
    fileContent: `<div data-foo=' class="fake" ' class="real"></div>`,
    filePath: "test.html"
  };
  const result = prefixElementAttribute(comp, "class", "123", true);
  console.log(result.fileContent);
  expect(result.fileContent).not.toContain("bascik__MyComp__fake");
  expect(result.fileContent).toContain("bascik__MyComp__real");
});
