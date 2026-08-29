/**
 * @module html-minifier
 * Built-in lightweight, safe HTML minifier for Bascik.
 *
 * Strips HTML comments, collapses redundant whitespace while preserving
 * whitespace between inline HTML elements, preserves <pre> and <textarea>
 * contents verbatim, and consolidates script tags at the end of the output.
 */

export const extractScriptTags = (htmlString: string): string => {
  const html = htmlString.replace(/<!--[\s\S]*?-->/g, "");
  const pattern = new RegExp(
    `<script(?:(?!(?:type=["'](?!(?:text\\/javascript|application\\/javascript|module)(?:["'\\s]|$))[^"']*["']|data-bascik-build|data-bascik-server))[^>])*>([\\s\\S]*?)<\\/script>`,
    "gi"
  );
  const arr = [...html.matchAll(pattern)];
  if (!arr.length) return "";
  return arr
    .map((script) => script[0])
    .join("\n")
    .trim();
};

export const INLINE_TAGS = new Set([
  "a",

  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "button",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "i",
  "img",
  "input",
  "kbd",
  "label",
  "mark",
  "meter",
  "output",
  "progress",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "script",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "textarea",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

export const minifyHtml = (htmlString: string): string => {
  let html = htmlString.replace(/<!--[\s\S]*?-->/g, "");
  const scriptTags = extractScriptTags(html);
  if (scriptTags) {
    const pattern = new RegExp(
      `<script(?:(?!(?:type=["'](?!(?:text\\/javascript|application\\/javascript|module)(?:["'\\s]|$))[^"']*["']|data-bascik-build|data-bascik-server))[^>])*>([\\s\\S]*?)<\\/script>`,
      "gi"
    );
    html = html.replace(pattern, "").trim();
  }
  // Preserve content of whitespace-sensitive elements before collapsing whitespace.
  // Without this, code inside <pre> blocks has its newlines and indentation stripped,
  // breaking the visual display of code examples in the browser.
  const preserved: string[] = [];
  html = html.replace(
    /<(pre|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (match) => {
      preserved.push(match);
      return `\x00P${preserved.length - 1}\x00`;
    },
  );
  html = html.replace(/\n/g, " ").replace(/\s\s+/g, " ");
  html = html.replace(/>\s+</g, (match, offset, fullString) => {
    const lastOpen = fullString.lastIndexOf("<", offset);
    const prevTagMatch =
      lastOpen !== -1
        ? fullString.slice(lastOpen, offset + 1).match(/^<\/?([a-zA-Z0-9-]+)/)
        : null;
    const prevTag = prevTagMatch ? prevTagMatch[1].toLowerCase() : "";

    const nextStart = offset + match.length - 1;
    const nextTagMatch = fullString
      .slice(nextStart, nextStart + 64)
      .match(/^<\/?([a-zA-Z0-9-]+)/);
    const nextTag = nextTagMatch ? nextTagMatch[1].toLowerCase() : "";

    if (INLINE_TAGS.has(prevTag) && INLINE_TAGS.has(nextTag)) {
      return "> <";
    }
    return "><";
  });
  if (preserved.length) {
    // Collapse any whitespace that landed between a tag boundary and a placeholder
    // after newline removal (e.g. "<div> \x00P0\x00 <" → "<div>\x00P0\x00<").
    html = html.replace(/>\s+(\x00P\d+\x00)/g, ">$1");
    html = html.replace(/(\x00P\d+\x00)\s+</g, "$1<");
    html = html.replace(
      /\x00P(\d+)\x00/g,
      (_: string, i: string) => preserved[parseInt(i, 10)],
    );
  }
  if (scriptTags) {
    html += `\n${scriptTags}`;
  }
  return html;
};
