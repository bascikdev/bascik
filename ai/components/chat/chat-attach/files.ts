/*
 * What chat-attach checks before a file is sent: the limits a page set, and
 * the reason a file is refused, in the words the server uses for the same
 * refusal (see `refusals` in @bascik/ai/files). The server checks every file
 * again; this only saves the reader a round trip.
 */

/** What is known of a file before it is sent. */
export interface ChosenFile {
  name: string;
  /** The media type the browser gave it, which may be empty. */
  type: string;
  size: number;
}

/** How many files one message may carry, how large, and of which types. */
export interface AttachLimits {
  maxBytes: number;
  maxFiles: number;
  maxTotal: number;
  /** The media types that are allowed. */
  types: string[];
}

const MB = 1024 * 1024;

/** The types allowed when a page names none, with the name each is shown by. */
export const KNOWN: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
  "application/pdf": "PDF",
  "text/plain": "plain text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
};

const BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
};

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * The limits a page set as `data-*` values (`maxBytes`, `maxFiles`,
 * `maxTotal`, and `types` as a comma-separated list), with the server's own
 * defaults for whatever it left out.
 */
export function attachLimits(
  data: Readonly<Record<string, string | undefined>>,
): AttachLimits {
  const types = (data.types ?? "")
    .split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  return {
    maxBytes: positive(data.maxBytes, 5 * MB),
    maxFiles: positive(data.maxFiles, 4),
    maxTotal: positive(data.maxTotal, 10 * MB),
    types: types.length ? types : Object.keys(KNOWN),
  };
}

/** A size as the reader sees it: "12 B", "1.5 KB", "2 MB". */
export const sizeText = (bytes: number): string =>
  bytes >= MB
    ? `${Number((bytes / MB).toFixed(1))} MB`
    : bytes >= 1024
      ? `${Number((bytes / 1024).toFixed(1))} KB`
      : `${bytes} B`;

/** The type a file claims: what the browser said, or its extension. */
export const claimedType = (file: ChosenFile): string =>
  file.type.split(";")[0]!.toLowerCase() ||
  BY_EXTENSION[file.name.split(".").pop()!.toLowerCase()] ||
  "";

/*
 * The server's name check (`claimsMarkup` in files.ts): the extension is
 * read without invisible characters or trailing dots and spaces, both as
 * sent and as `cleanName` will store it.
 */
const bare = (name: string): string =>
  name.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/[\s.]+$/u, "");
const stored = (name: string): string =>
  [
    ...(name.split(/[\\/]/).pop() ?? "")
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, 120)
    .join("")
    .trim();
const MARKUP_NAME = /\.(html?|xhtml|svg|svgz|xml)$/i;
const MARKUP_TYPE =
  /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)$/;

/** Whether a file's name says it is markup, as sent or as it will be stored. */
export const markupName = (name: string): boolean =>
  MARKUP_NAME.test(bare(name)) || MARKUP_NAME.test(bare(stored(name)));

/**
 * Why `file` cannot join the files already `chosen`, or null when it can.
 * Only what can be known before sending is checked.
 */
export function refusal(
  file: ChosenFile,
  chosen: readonly ChosenFile[],
  limits: AttachLimits,
): string | null {
  const name = file.name.split(/[\\/]/).pop() || "file";
  const { maxBytes, maxFiles, maxTotal, types } = limits;
  if (chosen.length >= maxFiles) {
    return `You can attach up to ${maxFiles} file${maxFiles === 1 ? "" : "s"} to one message.`;
  }
  const type = claimedType(file);
  if (MARKUP_TYPE.test(type) || markupName(file.name)) {
    return `"${name}" cannot be attached: HTML and SVG files are not allowed.`;
  }
  if (!types.includes(type)) {
    return `"${name}" cannot be attached: that type of file is not allowed. Allowed types: ${types.map((one) => KNOWN[one] ?? one).join(", ")}.`;
  }
  if (file.size === 0) return `"${name}" is empty.`;
  if (file.size > maxBytes) {
    return `"${name}" is too large (${sizeText(file.size)}). Each file can be up to ${sizeText(maxBytes)}.`;
  }
  const total = chosen.reduce((sum, one) => sum + one.size, file.size);
  if (total > maxTotal) {
    return `These files are too large together (${sizeText(total)}). One message can carry up to ${sizeText(maxTotal)}.`;
  }
  return null;
}
