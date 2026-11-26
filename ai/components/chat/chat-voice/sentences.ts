/*
 * What chat-voice says of a streaming reply: the reply's prose (a component
 * only by its data-say text), cut into whole sentences as they arrive. The
 * component passes the reply element; the cutting is pure.
 */

/** Elements read as part of the prose around them. */
const INLINE = new Set(["STRONG", "B", "EM", "I", "CODE"]);

/**
 * The words of a reply that make sense spoken. Prose is read as written.
 * A component is a picture, so it is skipped, unless an element in it
 * says what it shows with `data-say`.
 */
export function speakable(reply: Element): string {
  let text = "";
  for (const node of reply.childNodes) {
    if (node instanceof Text) {
      text += node.data;
    } else if (node instanceof Element) {
      if (INLINE.has(node.tagName)) {
        text += node.textContent;
        continue;
      }
      // A data attribute is not renamed per instance, so it can be selected as written.
      // bascik-ignore js-attribute-selector
      const said = [node, ...node.querySelectorAll("[data-say]")]
        .map((element) => element.getAttribute("data-say")?.trim())
        .filter(Boolean);
      text += said.length ? `\n${said.join(".\n")}.\n` : "\n";
    }
  }
  return text;
}

/**
 * How much of `rest` is whole sentences, ready to say. Once the reply is
 * `over`, all of it is; before, the rest of the last sentence is still coming.
 */
export function sentenceEnd(rest: string, over: boolean): number {
  if (over) return rest.length;
  return Math.max(
    rest.lastIndexOf("\n") + 1,
    ...[". ", "! ", "? ", ": "].map((mark) => {
      const at = rest.lastIndexOf(mark);
      return at < 0 ? 0 : at + mark.length;
    }),
  );
}

/** Whole sentences, one space between words, each with a letter or digit in it. */
export function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  for (const sentence of text.split(/(?<=[.!?:])\s+|\n+/)) {
    const clean = sentence.replace(/\s+/g, " ").trim();
    if (/[\p{L}\p{N}]/u.test(clean)) sentences.push(clean);
  }
  return sentences;
}
