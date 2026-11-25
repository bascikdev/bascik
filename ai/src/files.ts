/**
 * Files a reader attaches to a message: where they are kept, what is let in,
 * and how they are served back.
 *
 * Everything an upload could do to the app is decided here, not in a route:
 * the limits, which types are accepted and how a type is told, the name that
 * is kept, and the headers a file is served with. An app passes a `FileStore`
 * (two are here; a consumer backs one with object storage) and, if it wants,
 * its own limits. A file is only ever stored for the reader who sent it and
 * only ever served back to them.
 */
import { randomUUID } from "node:crypto";
import { escapeHtml } from "./render.ts";
import { isSafeKey } from "./store.ts";

/* ---- Storage ---- */

/** What is known about a stored file. */
export interface FileMeta {
  /** A display name, already cleaned: never a path, and never used as one. */
  name: string;
  /** The type the bytes were checked to be. */
  mediaType: string;
  size: number;
}

export interface StoredFile extends FileMeta {
  bytes: Uint8Array;
}

/**
 * What the chat needs from file storage. A reader and a file id are keys the
 * library made (an id is a generated UUID, never taken from an upload), and a
 * store refuses any other shape before it uses one as a key or a path.
 * `get` and `put` hand over copies, like a conversation store does.
 */
export interface FileStore {
  put(reader: string, id: string, file: StoredFile): Promise<void>;
  /** The reader's file with that id, or null when there is none. */
  get(reader: string, id: string): Promise<StoredFile | null>;
  remove(reader: string, id: string): Promise<void>;
}

function assertSafe(reader: string, id: string): void {
  if (!isSafeKey(reader)) throw new Error("That reader id cannot be stored.");
  if (!isSafeKey(id)) throw new Error("That file id cannot be stored.");
}

const copy = (file: StoredFile): StoredFile => ({
  name: file.name,
  mediaType: file.mediaType,
  size: file.size,
  bytes: file.bytes.slice(),
});

/** Files in this process's memory: for tests, demos, and a first try. */
export function inMemoryFiles(): FileStore {
  const readers = new Map<string, Map<string, StoredFile>>();
  return {
    async put(reader, id, file) {
      assertSafe(reader, id);
      let own = readers.get(reader);
      if (!own) readers.set(reader, (own = new Map()));
      own.set(id, copy(file));
    },
    async get(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return null;
      const found = readers.get(reader)?.get(id);
      return found ? copy(found) : null;
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      readers.get(reader)?.delete(id);
    },
  };
}

/**
 * Two files per upload under `<directory>/<reader>/`: `<id>.bin` with the
 * bytes and `<id>.json` with the name and type. The name is data in the JSON
 * and never part of a path. Like the conversation file store it suits one
 * server; with several, use object storage.
 */
export function diskFiles(directory: string): FileStore {
  const modules = Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const place = async (reader: string, id: string) => {
    const [, path] = await modules;
    const base = path.join(directory, reader, id);
    return {
      dir: path.dirname(base),
      bin: `${base}.bin`,
      meta: `${base}.json`,
    };
  };
  return {
    async put(reader, id, file) {
      assertSafe(reader, id);
      const [fs] = await modules;
      const where = await place(reader, id);
      await fs.mkdir(where.dir, { recursive: true });
      const meta: FileMeta = {
        name: file.name,
        mediaType: file.mediaType,
        size: file.size,
      };
      // The bytes first, then the description that makes them findable: a
      // file is never half there.
      const partial = `${where.bin}.${randomUUID()}.tmp`;
      await fs.writeFile(partial, file.bytes);
      await fs.rename(partial, where.bin);
      await fs.writeFile(where.meta, JSON.stringify(meta));
    },
    async get(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return null;
      const [fs] = await modules;
      const where = await place(reader, id);
      try {
        const meta: unknown = JSON.parse(await fs.readFile(where.meta, "utf8"));
        if (!isMeta(meta)) return null;
        const bytes = new Uint8Array(await fs.readFile(where.bin));
        if (bytes.byteLength !== meta.size) return null;
        return {
          name: meta.name,
          mediaType: meta.mediaType,
          size: meta.size,
          bytes,
        };
      } catch {
        return null;
      }
    },
    async remove(reader, id) {
      if (!isSafeKey(reader) || !isSafeKey(id)) return;
      const [fs] = await modules;
      const where = await place(reader, id);
      await Promise.all(
        [where.bin, where.meta].map((file) => fs.rm(file, { force: true })),
      );
    },
  };
}

function isMeta(value: unknown): value is FileMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<FileMeta>;
  return (
    typeof meta.name === "string" &&
    typeof meta.mediaType === "string" &&
    typeof meta.size === "number"
  );
}

/* ---- What is let in ---- */

/** The types accepted unless an app chooses fewer. */
export const DEFAULT_FILE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
];

export interface FileLimits {
  /** The largest one file may be, in bytes. Default 5 MB. */
  maxFileBytes?: number;
  /** The most files one message may carry. Default 4. */
  maxFiles?: number;
  /** The most all of one message's files may add up to, in bytes. Default 10 MB. */
  maxTotalBytes?: number;
  /**
   * The most bytes of files one model request may carry, counted from the
   * newest file back; older files are named to the model instead. The
   * newest message's files are always sent, so this cannot be below
   * `maxTotalBytes`. Default 20 MB, or `maxTotalBytes` when that is larger.
   */
  maxAttachedBytes?: number;
  /**
   * The media types accepted: a subset of `DEFAULT_FILE_TYPES`. A type that
   * is not one of those cannot be added, because the library only knows how
   * to check these; in particular SVG and HTML are never accepted.
   */
  types?: readonly string[];
}

export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 4;
export const DEFAULT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_ATTACHED_BYTES = 20 * 1024 * 1024;

export interface ResolvedFileLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxAttachedBytes: number;
  types: readonly string[];
}

/**
 * The limits with their defaults filled in. A `maxAttachedBytes` that is not
 * a positive whole number, or that is below `maxTotalBytes` (so a message
 * the app accepted could not be sent to the model), is a mistake in the
 * app's options and throws when the app starts.
 */
export function resolveLimits(limits: FileLimits = {}): ResolvedFileLimits {
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxAttachedBytes =
    limits.maxAttachedBytes ??
    Math.max(DEFAULT_MAX_ATTACHED_BYTES, maxTotalBytes);
  if (!Number.isSafeInteger(maxAttachedBytes) || maxAttachedBytes <= 0) {
    throw new RangeError(
      `fileLimits.maxAttachedBytes must be a positive whole number of bytes, not ${maxAttachedBytes}.`,
    );
  }
  if (maxAttachedBytes < maxTotalBytes) {
    throw new RangeError(
      `fileLimits.maxAttachedBytes (${maxAttachedBytes}) cannot be below fileLimits.maxTotalBytes (${maxTotalBytes}): the newest message's files are always sent.`,
    );
  }
  return {
    maxFileBytes: limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxFiles: limits.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes,
    maxAttachedBytes,
    types: (limits.types ?? DEFAULT_FILE_TYPES).filter((type) =>
      DEFAULT_FILE_TYPES.includes(type),
    ),
  };
}

const LABELS: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "application/pdf": "PDF",
  "text/plain": "plain text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
};

/** Images are shown in the page; everything else is offered as a download. */
export const isImageType = (mediaType: string): boolean =>
  mediaType.startsWith("image/");
export const isTextType = (mediaType: string): boolean =>
  mediaType.startsWith("text/");

/** `5 MB`, `12.5 KB`, `300 B`. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
  }
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  return `${bytes} B`;
}

/**
 * A name to show for an uploaded file. The browser sends whatever the file
 * is called on the reader's disk, so this keeps only the last path segment,
 * drops control and direction-changing characters, and shortens it. The
 * result is for display (always escaped by whatever shows it) and is never
 * used as a path.
 */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const short = [...cleaned].slice(0, 120).join("").trim();
  return short && short !== "." && short !== ".." ? short : "file";
}

/**
 * The extensions each checked type is kept under; the first is the one a
 * name is given when it has none of them.
 */
const EXTENSIONS: Record<string, readonly string[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt"],
  "text/markdown": ["md", "markdown"],
  "text/csv": ["csv"],
};

/**
 * The name a file is stored and served under: its cleaned name, ending in
 * an extension of the type its bytes were checked to be. When the name ends
 * any other way, that extension is added (`report.xht` holding plain text
 * becomes `report.xht.txt`), so whatever the reader's file was called, a
 * downloaded copy opens as only what it was checked to be. No list of
 * dangerous extensions is needed. A type the library does not know gets
 * `.bin`. The result stays within `cleanName`'s 120 characters.
 */
export function storedName(name: string, mediaType: string): string {
  const clean = cleanName(name);
  const allowed = EXTENSIONS[mediaType] ?? ["bin"];
  const ending = /\.([A-Za-z0-9]+)$/.exec(clean)?.[1]?.toLowerCase();
  if (ending && allowed.includes(ending)) return clean;
  const extension = `.${allowed[0]!}`;
  const base = [...clean].slice(0, 120 - extension.length).join("");
  return `${base}${extension}`;
}

/** What a reader is told. The page's script says the same words. */
export const refusals = {
  count: (max: number): string =>
    `You can attach up to ${max} file${max === 1 ? "" : "s"} to one message.`,
  tooLarge: (name: string, size: number, max: number): string =>
    `"${name}" is too large (${formatSize(size)}). Each file can be up to ${formatSize(max)}.`,
  total: (size: number, max: number): string =>
    `These files are too large together (${formatSize(size)}). One message can carry up to ${formatSize(max)}.`,
  empty: (name: string): string => `"${name}" is empty.`,
  type: (name: string, types: readonly string[]): string =>
    `"${name}" cannot be attached: that type of file is not allowed. Allowed types: ${types.map((type) => LABELS[type] ?? type).join(", ")}.`,
  markup: (name: string): string =>
    `"${name}" cannot be attached: HTML and SVG files are not allowed.`,
  mismatch: (name: string, claimed: string): string =>
    `"${name}" does not look like the ${LABELS[claimed] ?? claimed} file it says it is, so it was not attached.`,
};

const startsWith = (bytes: Uint8Array, signature: number[], at = 0): boolean =>
  bytes.length >= at + signature.length &&
  signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string): number[] =>
  [...text].map((character) => character.charCodeAt(0));

/** The binary type the leading bytes say a file is, or null. */
export function sniffBinary(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    startsWith(bytes, ascii("GIF87a")) ||
    startsWith(bytes, ascii("GIF89a"))
  ) {
    return "image/gif";
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  return null;
}

// Tab, line feed and carriage return are text; the other controls are not.
// eslint-disable-next-line no-control-regex
const BINARY_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MARKUP_START =
  /^\s*(?:<\?xml|<!doctype|<html|<svg|<script|<head|<body|<iframe|<!--)/i;

/**
 * The text of a file, when it is text: valid UTF-8 with no control
 * characters besides tab, line feed and carriage return. A file with a NUL
 * byte, or any binary format, is not.
 */
export function strictText(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return BINARY_CONTROL.test(text) ? null : text;
}

const MARKUP_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
]);
const MARKUP_NAME = /\.(?:html?|xhtml|svg|svgz|xml)$/i;
const BINARY_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

const mediaTypeOf = (claimed: string): string =>
  claimed.toLowerCase().split(";")[0]!.trim();

/**
 * A name as the extension check reads it: without invisible and control
 * characters, and without the trailing dots and spaces that Windows drops
 * when it saves a file. Otherwise `report.html` followed by a zero-width
 * space passes the check and is then stored as `report.html` by `cleanName`.
 * Combining marks and the Hangul fillers draw nothing either. The stored
 * name is given its checked type's extension anyway (`storedName`); this
 * keeps the refusal saying what the reader tried.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0]/gu;
const bareName = (name: string): string =>
  name.replace(INVISIBLE, "").replace(/[\s.]+$/u, "");

/**
 * True when the file says it is HTML, SVG or XML, by its type or its name.
 * The name is checked both as sent and as it will be stored (`cleanName`
 * also shortens it, which can leave a new extension at the end).
 */
export const claimsMarkup = (claimedType: string, name: string): boolean =>
  MARKUP_TYPES.has(mediaTypeOf(claimedType)) ||
  MARKUP_NAME.test(bareName(name)) ||
  MARKUP_NAME.test(bareName(cleanName(name)));

export type Sniffed =
  { mediaType: string } | { refused: "type" | "markup" | "mismatch" | "empty" };

/**
 * What a file is, decided by its bytes. A file's own claim (the type the
 * browser sent, the extension) never makes a file acceptable: it is only
 * used to say which text kind a plain text file is, and to refuse a file
 * that says one thing and is another.
 */
export function sniffFile(
  bytes: Uint8Array,
  claimedType: string,
  name: string,
  types: readonly string[] = DEFAULT_FILE_TYPES,
): Sniffed {
  if (bytes.byteLength === 0) return { refused: "empty" };
  const claimed = mediaTypeOf(claimedType);
  if (claimsMarkup(claimed, name)) return { refused: "markup" };
  const binary = sniffBinary(bytes);
  if (binary) {
    // A file that says it is a PNG and is a PDF is not what it says, but a
    // PNG renamed `.txt` is simply a PNG: the bytes decide.
    if (BINARY_TYPES.has(claimed) && claimed !== binary) {
      return { refused: "mismatch" };
    }
    return types.includes(binary) ? { mediaType: binary } : { refused: "type" };
  }
  if (BINARY_TYPES.has(claimed)) return { refused: "mismatch" };
  const text = strictText(bytes);
  if (text === null) return { refused: "type" };
  if (MARKUP_START.test(text.replace(/^\uFEFF/, "").slice(0, 1000))) {
    return { refused: "markup" };
  }
  const kind =
    claimed === "text/markdown" || /\.(?:md|markdown)$/i.test(name)
      ? "text/markdown"
      : claimed === "text/csv" || /\.csv$/i.test(name)
        ? "text/csv"
        : "text/plain";
  return types.includes(kind) ? { mediaType: kind } : { refused: "type" };
}

export interface CheckedFile {
  /** The id the file is stored under: made here, never taken from the upload. */
  id: string;
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export type UploadCheck =
  { ok: true; files: CheckedFile[] } | { ok: false; message: string };

/**
 * Check one message's uploads against the limits and their bytes, before any
 * is stored. The first problem found is the answer, in words for the reader.
 */
export async function checkUploads(
  uploads: readonly File[],
  limits: ResolvedFileLimits,
): Promise<UploadCheck> {
  if (uploads.length > limits.maxFiles) {
    return { ok: false, message: refusals.count(limits.maxFiles) };
  }
  let total = 0;
  for (const upload of uploads) {
    if (upload.size > limits.maxFileBytes) {
      return {
        ok: false,
        message: refusals.tooLarge(
          cleanName(upload.name),
          upload.size,
          limits.maxFileBytes,
        ),
      };
    }
    total += upload.size;
  }
  if (total > limits.maxTotalBytes) {
    return { ok: false, message: refusals.total(total, limits.maxTotalBytes) };
  }
  const files: CheckedFile[] = [];
  for (const upload of uploads) {
    const name = cleanName(upload.name);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const found = sniffFile(bytes, upload.type, upload.name, limits.types);
    if ("refused" in found) {
      return {
        ok: false,
        message:
          found.refused === "empty"
            ? refusals.empty(name)
            : found.refused === "markup"
              ? refusals.markup(name)
              : found.refused === "mismatch"
                ? refusals.mismatch(name, mediaTypeOf(upload.type))
                : refusals.type(name, limits.types),
      };
    }
    files.push({
      id: randomUUID(),
      name: storedName(upload.name, found.mediaType),
      mediaType: found.mediaType,
      bytes,
    });
  }
  return { ok: true, files };
}

/* ---- What is sent back ---- */

/** A name safe to put in a `Content-Disposition` header, in two forms. */
function dispositionName(name: string): string {
  const plain = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%;]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/**
 * A stored file as a response. Whatever the bytes are, they are shown as
 * only what they were checked to be (`nosniff`), only to the reader they
 * belong to (the caller looked it up for them), under a name that ends in
 * that type's extension (`storedName`), and with a policy that lets the
 * response do nothing if it is ever opened as a page. Images are shown
 * in the page; everything else is a download.
 */
export function fileResponse(file: StoredFile): Response {
  const known = DEFAULT_FILE_TYPES.includes(file.mediaType);
  const type = known
    ? isTextType(file.mediaType)
      ? `${file.mediaType}; charset=utf-8`
      : file.mediaType
    : "application/octet-stream";
  const inline = known && isImageType(file.mediaType);
  // Named again here, for a file stored by another store or an older
  // version under a name that does not end in its type's extension.
  const name = storedName(file.name, known ? file.mediaType : "");
  return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "content-type": type,
      "content-length": String(file.bytes.byteLength),
      "x-content-type-options": "nosniff",
      "content-disposition": `${inline ? "inline" : "attachment"}; ${dispositionName(name)}`,
      "cache-control": "private, max-age=3600",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      vary: "Cookie",
    },
  });
}

/**
 * The answer to a send that was refused, for a browser with no script: the
 * reason, the text the reader had typed (so it is not lost), and a way
 * back. The page's script reads the message out of it and shows it in the
 * composer instead.
 */
export function refusedPage(
  message: string,
  text: string,
  page: string,
): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not sent</title>
</head>
<body>
<main>
<h1>Not sent</h1>
<p role="alert" data-testid="attach-refused">${escapeHtml(message)}</p>
${text ? `<p>Your message, to copy:</p>\n<textarea readonly rows="6" cols="60" data-testid="attach-refused-text">${escapeHtml(text)}</textarea>` : ""}
<p><a href="${escapeHtml(page)}" data-testid="attach-refused-back">Back to the chat</a></p>
</main>
</body>
</html>
`;
  return new Response(body, {
    status: 422,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    },
  });
}
