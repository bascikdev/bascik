import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkUploads,
  cleanName,
  diskFiles,
  fileResponse,
  formatSize,
  inMemoryFiles,
  refusedPage,
  resolveLimits,
  sniffFile,
  strictText,
  type StoredFile,
} from "./files.ts";
import { fileStoreContract } from "./file-store.contract.ts";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const GIF = text("GIF89a\u0001\u0000");
const WEBP = text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const PDF = text("%PDF-1.7\n%…");

const file = (content: Uint8Array, name: string, type = ""): File =>
  new File([content as Uint8Array<ArrayBuffer>], name, { type });

const READER = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const stored = (name = "a.png"): StoredFile => ({
  name,
  mediaType: "image/png",
  size: PNG.length,
  bytes: PNG,
});

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

fileStoreContract("inMemoryFiles", () => inMemoryFiles(), {
  describe,
  it,
  expect,
});
fileStoreContract(
  "diskFiles",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "genui-files-"));
    folders.push(directory);
    return diskFiles(join(directory, "files"));
  },
  { describe, it, expect },
);

describe("diskFiles", () => {
  it("keeps a hostile name as data, never as a path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "genui-files-"));
    folders.push(directory);
    const store = diskFiles(join(directory, "files"));
    const name = "../../escape\u0000.png";
    await store.put(READER, ID, stored(name));
    expect((await store.get(READER, ID))!.name).toBe(name);
    expect(await readdir(join(directory, "files", READER))).toEqual(
      [`${ID}.bin`, `${ID}.json`].sort(),
    );
    expect(await readdir(directory)).toEqual(["files"]);
    expect(
      JSON.parse(
        await readFile(join(directory, "files", READER, `${ID}.json`), "utf8"),
      ),
    ).toMatchObject({ name });
  });

  it("does not serve a file whose bytes no longer match its record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "genui-files-"));
    folders.push(directory);
    const store = diskFiles(join(directory, "files"));
    await store.put(READER, ID, { ...stored(), size: 999 });
    expect(await store.get(READER, ID)).toBeNull();
  });
});

describe("cleanName", () => {
  it.each([
    ["cover.png", "cover.png"],
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\notes.txt", "notes.txt"],
    ["a\u0000b\nc.txt", "a b c.txt"],
    ["evil\u202Egnp.exe", "evil gnp.exe"],
    ["", "file"],
    ["..", "file"],
    ["/", "file"],
  ])("cleans %j to %j", (name, clean) => {
    expect(cleanName(name)).toBe(clean);
  });

  it("shortens a long name by characters", () => {
    expect([...cleanName("é".repeat(500))]).toHaveLength(120);
  });
});

describe("sniffFile: the bytes decide", () => {
  it.each([
    ["png", PNG, "image/png"],
    ["jpeg", JPEG, "image/jpeg"],
    ["gif", GIF, "image/gif"],
    ["webp", WEBP, "image/webp"],
    ["pdf", PDF, "application/pdf"],
  ])("recognizes a %s by its leading bytes", (_name, content, type) => {
    expect(sniffFile(content, "", "x")).toEqual({ mediaType: type });
  });

  it("takes a PNG renamed .txt for what it is", () => {
    expect(sniffFile(PNG, "text/plain", "notes.txt")).toEqual({
      mediaType: "image/png",
    });
  });

  it("refuses text that claims to be a PNG", () => {
    expect(sniffFile(text("<b>hi</b>"), "image/png", "a.png")).toEqual({
      refused: "mismatch",
    });
    expect(sniffFile(text("just words"), "image/png", "a.png")).toEqual({
      refused: "mismatch",
    });
  });

  it("refuses an HTML file claiming image/png", () => {
    expect(
      sniffFile(
        text("<!doctype html><script>alert(1)</script>"),
        "image/png",
        "x.png",
      ),
    ).toEqual({ refused: "mismatch" });
  });

  it("refuses a PDF that says it is a PNG", () => {
    expect(sniffFile(PDF, "image/png", "a.png")).toEqual({
      refused: "mismatch",
    });
  });

  it.each([
    [
      "<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>",
      "image/svg+xml",
      "a.svg",
    ],
    ["<svg xmlns='http://www.w3.org/2000/svg'/>", "text/plain", "a.txt"],
    ["  \n<!DOCTYPE html><p>x", "text/plain", "a.txt"],
    ["<html><body>x", "", "a"],
    ["<?xml version='1.0'?><svg/>", "", "a"],
    ["<script>alert(1)</script>", "text/plain", "a.txt"],
    ["\uFEFF<html>", "text/plain", "a.txt"],
    ["plain words", "text/html", "a.txt"],
    ["plain words", "text/plain", "page.html"],
    ["plain words", "", "drawing.svg"],
  ])("refuses HTML and SVG: %j (%s, %s)", (content, type, name) => {
    expect(sniffFile(text(content), type, name)).toEqual({ refused: "markup" });
  });

  it.each([
    "report.html​",
    "pic.svg﻿",
    "x.html‮",
    "report.html.",
    "report.html .. ",
    "report.htm⁠l",
    "page.xhtml\u0007",
    `${"a".repeat(115)}.htmlmore`,
    "report.html️",
    "report.htmlㅤ",
    "report.htmĺ",
    "report.htmlᅟ",
    "report.htmlﾠ",
  ])(
    "refuses a markup name hidden behind characters the stored name drops: %j",
    async (name) => {
      const content = "Notes\n<html><body><script>alert(1)</script>";
      expect(sniffFile(text(content), "text/plain", name)).toEqual({
        refused: "markup",
      });
      const checked = await checkUploads(
        [new File([content], name, { type: "text/plain" })],
        resolveLimits(),
      );
      expect(checked.ok).toBe(false);
    },
  );

  it.each([
    "report.xht",
    "report.shtml",
    "report.shtm",
    "report.xhtm",
    "report.mhtml",
    "report.mht",
    "report.xsl",
    "report.xslt",
    "report.hta",
    "report.php",
    "report.js",
    "report.exe",
    "report.TXT️",
    "report",
  ])(
    "stores and serves %j only under the extension of the type it was checked as",
    async (name) => {
      const content = "hello\n<script>alert(1)</script>\n";
      const checked = await checkUploads(
        [new File([content], name, { type: "text/plain" })],
        resolveLimits(),
      );
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      const [one] = checked.files;
      expect(one!.mediaType).toBe("text/plain");
      expect(one!.name).toMatch(/\.txt$/);
      // A file stored under its old name (another store, an older version)
      // is renamed when it is served, too.
      const disposition = fileResponse({
        name,
        mediaType: "text/plain",
        size: content.length,
        bytes: text(content),
      }).headers.get("content-disposition")!;
      expect(disposition).toMatch(/filename="[^"]*\.txt"; /);
      expect(disposition).toMatch(/filename\*=UTF-8''\S*\.txt$/);
    },
  );

  it("refuses a text file with a NUL byte, and other binary bytes", () => {
    expect(
      sniffFile(bytes(0x68, 0x69, 0x00, 0x21), "text/plain", "a.txt"),
    ).toEqual({
      refused: "type",
    });
    expect(sniffFile(bytes(0x68, 0x01, 0x21), "text/plain", "a.txt")).toEqual({
      refused: "type",
    });
    expect(
      sniffFile(bytes(0xff, 0xfe, 0x68, 0x00), "text/plain", "a.txt"),
    ).toEqual({
      refused: "type",
    });
    expect(strictText(bytes(0x80, 0x81))).toBeNull();
    expect(strictText(text("tab\there\r\nline"))).toBe("tab\there\r\nline");
  });

  it("refuses an empty file", () => {
    expect(sniffFile(bytes(), "text/plain", "a.txt")).toEqual({
      refused: "empty",
    });
  });

  it("refuses a binary type that is not on the allowlist", () => {
    expect(sniffFile(PDF, "", "a.pdf", ["image/png"])).toEqual({
      refused: "type",
    });
    expect(sniffFile(text("a,b"), "", "a.csv", ["text/plain"])).toEqual({
      refused: "type",
    });
  });

  it("tells the text kinds by claim and extension, only among text", () => {
    expect(sniffFile(text("# hi"), "", "a.md")).toEqual({
      mediaType: "text/markdown",
    });
    expect(sniffFile(text("a,b"), "text/csv", "a")).toEqual({
      mediaType: "text/csv",
    });
    expect(sniffFile(text("hi"), "application/octet-stream", "a")).toEqual({
      mediaType: "text/plain",
    });
  });
});

describe("checkUploads", () => {
  const limits = resolveLimits();

  it("accepts good files, with ids and names the library made", async () => {
    const result = await checkUploads(
      [
        file(PNG, "../../a.png", "image/png"),
        file(text("hello"), "n.txt", "text/plain"),
      ],
      limits,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.files.map((one) => [one.name, one.mediaType])).toEqual([
      ["a.png", "image/png"],
      ["n.txt", "text/plain"],
    ]);
    expect(result.files[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.files[0]!.id).not.toBe(result.files[1]!.id);
  });

  it.each([
    ["photo.txt", PNG, "image/png", "photo.txt.png"],
    ["photo.PNG", PNG, "image/png", "photo.PNG"],
    ["shot.jpg", JPEG, "image/jpeg", "shot.jpg"],
    ["shot.jpeg", JPEG, "image/jpeg", "shot.jpeg"],
    ["shot.png", JPEG, "", "shot.png.jpg"],
    ["paper", PDF, "", "paper.pdf"],
    ["notes.md", text("# hi"), "", "notes.md"],
    ["notes.markdown", text("# hi"), "", "notes.markdown"],
    ["notes", text("# hi"), "text/markdown", "notes.md"],
    ["data.csv", text("a,b"), "", "data.csv"],
    ["server.log", text("ok"), "text/plain", "server.log.txt"],
  ])(
    "gives %j the extension of the type its bytes are",
    async (name, content, type, kept) => {
      const result = await checkUploads([file(content, name, type)], limits);
      expect(result).toMatchObject({ ok: true, files: [{ name: kept }] });
    },
  );

  it("keeps a long name to 120 characters with its extension", async () => {
    const result = await checkUploads(
      [file(text("hi"), `${"é".repeat(200)}.xht`, "text/plain")],
      limits,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const name = result.files[0]!.name;
    expect([...name]).toHaveLength(120);
    expect(name).toMatch(/é\.txt$/);
  });

  it("has the documented defaults", () => {
    expect(limits).toMatchObject({
      maxFileBytes: 5 * 1024 * 1024,
      maxFiles: 4,
      maxTotalBytes: 10 * 1024 * 1024,
      maxAttachedBytes: 20 * 1024 * 1024,
    });
    expect(limits.types).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
    ]);
  });

  it("lets an app set what one model request may carry, never below one message", () => {
    const MB = 1024 * 1024;
    expect(resolveLimits({ maxAttachedBytes: 50 * MB }).maxAttachedBytes).toBe(
      50 * MB,
    );
    // Raising the per-message limit raises the default with it, so the
    // newest message always fits.
    expect(
      resolveLimits({ maxFileBytes: 25 * MB, maxTotalBytes: 30 * MB })
        .maxAttachedBytes,
    ).toBe(30 * MB);
    expect(() =>
      resolveLimits({ maxTotalBytes: 30 * MB, maxAttachedBytes: 20 * MB }),
    ).toThrow(/maxAttachedBytes/);
    for (const bad of [0, -1, Number.NaN, -Infinity, 1.5]) {
      expect(() => resolveLimits({ maxAttachedBytes: bad })).toThrow(
        /maxAttachedBytes/,
      );
    }
  });

  it("keeps accepting an unbounded or very large maxTotalBytes", () => {
    // An app that lifts the per-message cap without naming the per-request
    // one gets a per-request cap that still fits a message, never an error
    // blaming an option it did not set.
    for (const total of [Infinity, 2 ** 60, Number.MAX_SAFE_INTEGER + 2]) {
      expect(resolveLimits({ maxTotalBytes: total }).maxAttachedBytes).toBe(
        total,
      );
    }
    // No cap at all, or one past the safe integers, is the app's choice.
    expect(resolveLimits({ maxAttachedBytes: Infinity }).maxAttachedBytes).toBe(
      Infinity,
    );
    expect(resolveLimits({ maxAttachedBytes: 2 ** 60 }).maxAttachedBytes).toBe(
      2 ** 60,
    );
    expect(
      resolveLimits({ maxTotalBytes: Infinity, maxAttachedBytes: Infinity })
        .maxAttachedBytes,
    ).toBe(Infinity);
    expect(() =>
      resolveLimits({ maxTotalBytes: Infinity, maxAttachedBytes: 2 ** 60 }),
    ).toThrow(/cannot be below/);
  });

  it("only accepts types the library knows how to check", () => {
    expect(
      resolveLimits({ types: ["image/svg+xml", "text/html", "image/png"] })
        .types,
    ).toEqual(["image/png"]);
  });

  it("refuses an oversize file, naming it", async () => {
    const big = file(new Uint8Array(101), "big.txt", "text/plain");
    const result = await checkUploads(
      [big],
      resolveLimits({ maxFileBytes: 100 }),
    );
    expect(result).toEqual({
      ok: false,
      message: '"big.txt" is too large (101 B). Each file can be up to 100 B.',
    });
  });

  it("refuses too many files", async () => {
    const many = Array.from({ length: 5 }, (_, at) =>
      file(text("x"), `${at}.txt`, "text/plain"),
    );
    expect(await checkUploads(many, limits)).toEqual({
      ok: false,
      message: "You can attach up to 4 files to one message.",
    });
    expect(
      await checkUploads(many.slice(0, 2), resolveLimits({ maxFiles: 1 })),
    ).toEqual({
      ok: false,
      message: "You can attach up to 1 file to one message.",
    });
  });

  it("refuses files that are too large together", async () => {
    const two = [
      file(text("x".repeat(60)), "a.txt", "text/plain"),
      file(text("x".repeat(60)), "b.txt", "text/plain"),
    ];
    const result = await checkUploads(
      two,
      resolveLimits({ maxTotalBytes: 100 }),
    );
    expect(result).toEqual({
      ok: false,
      message:
        "These files are too large together (120 B). One message can carry up to 100 B.",
    });
  });

  it("refuses an SVG, an HTML file, and a NUL byte with a clear message", async () => {
    expect(
      await checkUploads(
        [file(text("<svg/>"), "a.svg", "image/svg+xml")],
        limits,
      ),
    ).toEqual({
      ok: false,
      message:
        '"a.svg" cannot be attached: HTML and SVG files are not allowed.',
    });
    expect(
      await checkUploads(
        [file(text("<!doctype html>"), "a.png", "image/png")],
        limits,
      ),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not look like the PNG"),
    });
    expect(
      await checkUploads(
        [file(bytes(0x61, 0, 0x62), "a.txt", "text/plain")],
        limits,
      ),
    ).toEqual({
      ok: false,
      message:
        '"a.txt" cannot be attached: that type of file is not allowed. Allowed types: PNG, JPEG, WebP, GIF, PDF, plain text, Markdown, CSV.',
    });
  });

  it("refuses an empty file", async () => {
    expect(
      await checkUploads([file(bytes(), "e.txt", "text/plain")], limits),
    ).toEqual({
      ok: false,
      message: '"e.txt" is empty.',
    });
  });

  it("names a hostile file by its cleaned name in a message", async () => {
    const result = await checkUploads(
      [file(text("<svg/>"), "x/..\\<b>.svg", "")],
      limits,
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining('"<b>.svg"'),
    });
  });
});

describe("fileResponse", () => {
  it("serves an image inline as its checked type, with every guard header", async () => {
    const response = fileResponse(stored("cover.png"));
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toMatch(
      /^inline; filename="cover.png"/,
    );
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("content-length")).toBe(String(PNG.length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  it.each([
    ["application/pdf", "application/pdf"],
    ["text/plain", "text/plain; charset=utf-8"],
    ["text/markdown", "text/markdown; charset=utf-8"],
    ["text/csv", "text/csv; charset=utf-8"],
  ])("serves %s as a download", (mediaType, sent) => {
    const response = fileResponse({ ...stored("n.pdf"), mediaType });
    expect(response.headers.get("content-type")).toBe(sent);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("serves a stored type it does not know as an opaque download", () => {
    for (const mediaType of ["text/html", "image/svg+xml", "whatever"]) {
      const response = fileResponse({ ...stored(), mediaType });
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment;/,
      );
    }
  });

  it("encodes a hostile name so it cannot break out of the header", () => {
    const response = fileResponse(
      stored('a"; filename=evil.html\r\nX: y é%.png'),
    );
    const disposition = response.headers.get("content-disposition")!;
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toMatch(
      /^inline; filename="[^"\\]*"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/,
    );
    expect(disposition).not.toContain("evil.html;");
  });
});

describe("refusedPage and formatSize", () => {
  it("escapes the message and the kept text", async () => {
    const response = refusedPage(
      '"<b>x</b>" bad',
      "<script>alert(1)</script>",
      "/books",
    );
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<b>x</b>");
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain('href="/books"');
  });

  it("writes sizes the way a reader reads them", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
  });
});
