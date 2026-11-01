import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EditorModeMirror,
  editorModeMirror,
  editorModeText,
} from "./typescript-editor-mode.js";
import type { TypeScriptModule } from "./typescript-loader.js";
import { offsetOf, typescript6 as ts } from "./typescript.test.util.js";

const SERVER = `<!doctype html>
<p>Milk frother</p>
<script type="text/typescript" data-bascik-server>
  import { makeLogger } from "@/lib/logger.ts";
  export default async function (request, context) {
    console.log(request.url);
    const url = new URL(request.url);
    const log = makeLogger();
    return url.pathname + context.remoteIp + log;
  }
</script>
<script>
  const plainFrother = { size: 2 };
</script>
`;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("editorModeText", () => {
  it("keeps every TypeScript block in place and blanks the rest, newlines kept", () => {
    const text = editorModeText(SERVER);
    expect(text.length).toBe(SERVER.length);
    expect(text.split("\n").length).toBe(SERVER.split("\n").length);
    const block = SERVER.indexOf("  import");
    expect(text.slice(block, block + 20)).toBe(SERVER.slice(block, block + 20));
    // The page's markup and a plain script are not the editor's TypeScript.
    expect(text).not.toContain("Milk frother");
    expect(text).not.toContain("plainFrother");
    expect(text).not.toContain("<script");
  });

  it("is all blanks for a page without TypeScript blocks", () => {
    expect(editorModeText("<p>Frother</p>\n").trim()).toBe("");
  });
});

describe("EditorModeMirror", () => {
  const at = (html: string, needle: string, delta = 0) =>
    editorModeMirror(ts).at(html, offsetOf(html, needle, delta));

  it("knows the DOM's globals and their members in a server block, whatever its directive", () => {
    expect(at(SERVER, "console.log", 1).typesName()).toBe(true);
    expect(at(SERVER, "console.log", 1).definesInLibrary()).toBe(true);
    expect(at(SERVER, "log(request", 1).typesName()).toBe(true);
    expect(at(SERVER, "new URL", 5).definesInLibrary()).toBe(true);
    // A name the page declares from a DOM constructor is typed there too.
    expect(at(SERVER, "url = new", 1).typesName()).toBe(true);
  });

  it("does not know what only Bascik types: parameters, imports, and what they give", () => {
    expect(at(SERVER, "request.url", 1).typesName()).toBe(false);
    expect(at(SERVER, "context.remoteIp", 1).typesName()).toBe(false);
    expect(at(SERVER, "makeLogger()", 1).typesName()).toBe(false);
    expect(at(SERVER, "makeLogger()", 1).definesInLibrary()).toBe(false);
    expect(at(SERVER, "log = make", 1).typesName()).toBe(false);
  });

  it("does not know a Node global the DOM lacks, nor a typo", () => {
    const html = SERVER.replace(
      "console.log(request.url);",
      "process.cwd();\n    consol.log(1);",
    );
    expect(at(html, "process.cwd", 1).typesName()).toBe(false);
    expect(at(html, "process.cwd", 1).definesInLibrary()).toBe(false);
    expect(at(html, "consol.log", 1).typesName()).toBe(false);
  });

  it("completes the DOM's globals and nothing for an untyped receiver", () => {
    const html = SERVER.replace("console.log(request.url);", "con");
    const globals = at(html, "    con\n", 7).completionNames();
    expect(globals.has("console")).toBe(true);
    expect(globals.has("process")).toBe(false);
    const member = SERVER.replace("console.log(request.url);", "request.");
    expect(at(member, "request.\n", 8).completionNames(".").size).toBe(0);
  });

  it("shows a signature for a DOM function, not for an unresolved import", () => {
    const html = SERVER.replace(
      "console.log(request.url);",
      "setTimeout();\n    makeLogger();",
    );
    expect(at(html, "setTimeout()", 11).hasSignature()).toBe(true);
    expect(at(html, "makeLogger();", 11).hasSignature()).toBe(false);
  });

  it("answers for the page asked about, after another page used the mirror", () => {
    const other = '<script type="text/typescript">\n  let x = 1;\n</script>\n';
    const answers = at(SERVER, "console.log", 1);
    at(other, "x = 1", 0).typesName();
    expect(answers.typesName()).toBe(true);
  });

  it("is one mirror per TypeScript", () => {
    expect(editorModeMirror(ts)).toBe(editorModeMirror(ts));
  });

  it("knows nothing, and does not throw, with a TypeScript that lacks the editor's library", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bascik-no-lib-"));
    temporary.push(dir);
    const withoutLib = new Proxy(ts, {
      get: (target, key, receiver) =>
        key === "getDefaultLibFilePath"
          ? () => path.join(dir, "lib.d.ts")
          : Reflect.get(target, key, receiver),
    }) as TypeScriptModule;
    const answers = new EditorModeMirror(withoutLib).at(
      SERVER,
      offsetOf(SERVER, "console.log", 1),
    );
    expect(answers.typesName()).toBe(false);
    expect(answers.definesInLibrary()).toBe(false);
    expect(answers.completionNames().size).toBe(0);
    expect(answers.hasSignature()).toBe(false);
  });
});
