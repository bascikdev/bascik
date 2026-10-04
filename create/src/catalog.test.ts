import { describe, expect, it } from "vitest";
import { OFFICIAL_EXAMPLES, SourceError, normalizeExamplePath, parseExampleSource } from "./catalog.js";

describe("official examples", () => {
  it("resolves a known id to its examples/<id> branch, never to main", () => {
    expect(parseExampleSource("blog")).toEqual({
      kind: "official",
      owner: "bascikdev",
      repo: "bascik",
      ref: "examples/blog",
      path: "",
      label: "blog",
    });
  });

  it("lists every available id when the name is unknown, without a network request", () => {
    expect(() => parseExampleSource("nope")).toThrow(SourceError);
    expect(() => parseExampleSource("nope")).toThrow(/Available: blog\./);
  });

  it.each(["Blog", "../blog", "blog/", "templates/blog", "blog ", "", "-blog", "bl\\og"])("rejects the id %j", (id) => {
    expect(() => parseExampleSource(id)).toThrow(SourceError);
  });

  it("does not accept --example-path for an official id", () => {
    expect(() => parseExampleSource("blog", "sub")).toThrow(/only applies to GitHub links/);
  });

  it("has unique, well-formed ids", () => {
    const ids = OFFICIAL_EXAMPLES.map((example) => example.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe("GitHub links", () => {
  it("accepts a bare repository and uses the default branch", () => {
    expect(parseExampleSource("https://github.com/owner/repo")).toMatchObject({ kind: "github", owner: "owner", repo: "repo", ref: null, path: "" });
  });

  it("accepts a trailing slash, www, and a .git suffix", () => {
    expect(parseExampleSource("https://www.github.com/owner/repo.git/")).toMatchObject({ owner: "owner", repo: "repo", ref: null });
  });

  it("reads the branch and folder from a /tree/ link", () => {
    expect(parseExampleSource("https://github.com/owner/repo/tree/v1.2.0/apps/web/")).toMatchObject({ ref: "v1.2.0", path: "apps/web" });
  });

  it("accepts a commit hash as the ref", () => {
    expect(parseExampleSource("https://github.com/o/r/tree/0123456789abcdef0123456789abcdef01234567")).toMatchObject({ ref: "0123456789abcdef0123456789abcdef01234567" });
  });

  it("takes the folder from --example-path", () => {
    expect(parseExampleSource("https://github.com/owner/repo", "examples/blog")).toMatchObject({ ref: null, path: "examples/blog" });
  });

  it("refuses a folder named twice", () => {
    expect(() => parseExampleSource("https://github.com/o/r/tree/main/a", "b")).toThrow(/ambiguous/);
  });

  it.each([
    ["http://github.com/o/r", /Only https/],
    ["ftp://github.com/o/r", /Only https/],
    ["git://github.com/o/r", /Only https/],
    ["https://gitlab.com/o/r", /Only github\.com/],
    ["https://github.com.evil.test/o/r", /Only github\.com/],
    ["https://evil.test/github.com/o/r", /Only github\.com/],
    ["https://user:pass@github.com/o/r", /credentials/],
    ["https://github.com:8443/o/r", /credentials or a port/],
    ["https://github.com/o/r?x=1", /query string/],
    ["https://github.com/o/r#readme", /query string or a fragment/],
    ["https://github.com/o", /link to a repository/],
    ["https://github.com/", /link to a repository/],
    ["https://github.com/o/r/blob/main/package.json", /points at a file/],
    ["https://github.com/o/r/issues/1", /Unsupported GitHub link/],
    ["https://github.com/o/r/tree", /Unsupported GitHub link/],
    ["https://github.com/o/r/tree/feature%2Fx/app", /not a supported branch/],
    ["https://github.com/o/r/tree/a%00b", /not a supported branch/],
    ["https://github.com/o/r/tree/main/../x", /"\." or "\.\." part/],
    ["https://github.com/o/r/tree/main/a/%2e%2e/b", /"\." or "\.\." part/],
    ["https://github.com/o/r/tree/main/%2E/a", /"\." or "\.\." part/],
    ["https://github.com/o/r/tree/main/a/..", /"\." or "\.\." part/],
    ["https://github.com/o/r/tree/main/a%5cb", /backslashes/],
    ["https://github.com/../r", /"\." or "\.\." part/],
    ["https://github.com/o/..", /"\." or "\.\." part/],
    ["https://github.com/o/r%20x", /not a valid GitHub repository name/],
    ["not a url://", /not an official example/],
  ])("rejects %s", (link, message) => {
    expect(() => parseExampleSource(link)).toThrow(message);
  });
});

describe("normalizeExamplePath", () => {
  it.each([
    ["a/b", "a/b"],
    ["/a/b/", "a/b"],
    ["", ""],
    ["/", ""],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeExamplePath(input)).toBe(expected);
  });

  it.each(["../a", "a/../b", "a//b", "./a", "a/./b", "a\\b", "a\u0000b", "a\nb"])("rejects %j", (input) => {
    expect(() => normalizeExamplePath(input)).toThrow(SourceError);
  });
});
