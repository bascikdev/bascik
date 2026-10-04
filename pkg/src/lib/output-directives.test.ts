import { describe, expect, it } from "vitest";
import { removeOutputDirectives } from "./output-directives.ts";

describe("removeOutputDirectives", () => {
  it("leaves output without directive scripts unchanged", () => {
    const html = '<p>Hi</p><script>window.x = 1</script><post-card data-bascik-prop-title="A"></post-card>';
    expect(removeOutputDirectives(html)).toEqual({ html, removed: [] });
  });

  it.each([
    ["data-bascik-build", '<script data-bascik-build>import "node:fs"</script>'],
    ["data-bascik-build", '<script data-bascik-build="page">x()</script>'],
    ["data-bascik-server", "<script data-bascik-server>export default () => 1</script>"],
    ["data-bascik-server", '<script type="module" data-bascik-server data-bascik-stream>x</script>'],
    ["data-bascik-routes", "<script data-bascik-routes>console.log('[]')</script>"],
    ["data-bascik-build", '<SCRIPT DATA-BASCIK-BUILD src="./x.ts"></SCRIPT >'],
  ])("removes a printed %s script", (directive, tag) => {
    const result = removeOutputDirectives(`<p>a</p>${tag}<p>b</p>`);
    expect(result.html).toBe("<p>a</p><p>b</p>");
    expect(result.removed).toEqual([directive]);
  });

  it("removes an unclosed directive open tag so no later pass can pair it with a closing tag", () => {
    const result = removeOutputDirectives("<p>a</p><script data-bascik-build>x()");
    expect(result.html).not.toMatch(/data-bascik-build/i);
    expect(result.removed).toEqual(["data-bascik-build"]);
  });

  it("does not treat lookalike attributes or escaped text as directives", () => {
    const html =
      '<script data-bascik-server-id="abc"></script><p data-note="data-bascik-build">&lt;script data-bascik-build&gt;</p>' +
      "<script data-bascik-builder>1</script>";
    expect(removeOutputDirectives(html)).toEqual({ html, removed: [] });
  });

  it("is safe with replacement tokens in surrounding text", () => {
    const result = removeOutputDirectives("<p>$1 $& $`</p><script data-bascik-build>x</script><p>$'</p>");
    expect(result.html).toBe("<p>$1 $& $`</p><p>$'</p>");
  });
});
