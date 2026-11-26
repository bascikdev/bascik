/**
 * How a file is named and described: image and text types, a readable size,
 * the cleaned display name, and the name it is stored and served under.
 */

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
