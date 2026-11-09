import { maskRawTextContent } from "./component-masking.ts";
import { maskElementContents } from "./shielding.ts";

export interface TemplateShapeProblem {
  kind: "component-document" | "native-slot-element";
  offset: number;
  message: string;
}

/**
 * Markup a component template cannot use, read with comments, raw text, and
 * code samples masked: page chrome (finding 24), which the page would get
 * pasted into its <body> verbatim, and a native <slot> outside a <template>
 * (finding 23), which Bascik passes through literally while the usage's
 * children are dropped.
 */
export const templateShapeProblems = (scan: string): TemplateShapeProblem[] => {
  const masked = maskRawTextContent(scan);
  const problems: TemplateShapeProblem[] = [];
  const chrome: string[] = [];
  let chromeAt = -1;
  for (const match of masked.matchAll(
    /<(!doctype|html|head|body)(?=[\s/>])/gi,
  )) {
    const tag =
      match[1].toLowerCase() === "!doctype"
        ? "<!DOCTYPE>"
        : `<${match[1].toLowerCase()}>`;
    if (!chrome.includes(tag)) chrome.push(tag);
    if (chromeAt === -1) chromeAt = match.index ?? 0;
  }
  if (chrome.length > 0) {
    problems.push({
      kind: "component-document",
      offset: chromeAt,
      message:
        `this component is a whole HTML document (${chrome.join(", ")}), and every page that uses it gets that markup pasted into its <body>. ` +
        "Move the page chrome to a page in src/pages/ and keep the component to the elements it renders.",
    });
  }
  const outsideTemplates = maskElementContents(masked, ["template"]);
  const slot = /<slot(?=[\s/>])/i.exec(outsideTemplates);
  if (slot) {
    problems.push({
      kind: "native-slot-element",
      offset: slot.index,
      message:
        "a native <slot> element only works in a shadow root; Bascik leaves it in the output as written and drops the usage's children. " +
        'Mark the element that receives children with data-bascik-slot (or data-bascik-slot="name" for a named slot).',
    });
  }
  return problems;
};
