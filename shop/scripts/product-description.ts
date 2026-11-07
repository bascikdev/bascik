import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

export function productDescription(html: string): string {
  function text(node: DefaultTreeAdapterTypes.ChildNode): string {
    if (node.nodeName === "#text")
      return (node as DefaultTreeAdapterTypes.TextNode).value;
    if (!("tagName" in node)) return "";
    if (["script", "style", "template"].includes(node.tagName)) return "";
    if (node.tagName === "br") return "\n";
    return (
      node.childNodes.map(text).join("") + (node.tagName === "p" ? "\n" : "")
    );
  }
  return parseFragment(html)
    .childNodes.map(text)
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
