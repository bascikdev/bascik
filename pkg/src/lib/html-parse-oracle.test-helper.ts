/**
 * Test oracle backed by parse5, a spec-compliant HTML parser: what a browser
 * parses from a document, to compare the input and output of steps that
 * remove or move markup. Test-only; never imported by production code.
 */
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import type { HtmlRange } from "./html-scanner.ts";

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const isElement = (node: ChildNode): node is Element => "tagName" in node;
const isTemplate = (node: Element): node is DefaultTreeAdapterTypes.Template =>
  node.tagName === "template" && node.namespaceURI === HTML_NAMESPACE && "content" in node;

export interface ParsedLocations {
  /** HTML-namespace script elements with an end tag, outside `<template>` and SVG/MathML. */
  scripts: HtmlRange[];
  /** Comment nodes written as `<!--`, anywhere in the document. */
  comments: HtmlRange[];
}

/** Script and comment source ranges as parse5 parses `html`, in document order. */
export const parsedLocations = (html: string): ParsedLocations => {
  const scripts: HtmlRange[] = [];
  const comments: HtmlRange[] = [];
  const visit = (parent: ParentNode, ordinary: boolean): void => {
    for (const node of parent.childNodes) {
      if (node.nodeName === "#comment") {
        const location = node.sourceCodeLocation;
        if (location && html.startsWith("<!--", location.startOffset)) {
          comments.push({ start: location.startOffset, end: location.endOffset });
        }
        continue;
      }
      if (!isElement(node)) continue;
      const html5 = node.namespaceURI === HTML_NAMESPACE;
      if (ordinary && html5 && node.tagName === "script") {
        const location = node.sourceCodeLocation;
        if (location?.endTag) scripts.push({ start: location.startOffset, end: location.endTag.endOffset });
      }
      if (isTemplate(node)) visit(node.content, false);
      else visit(node, ordinary && html5);
    }
  };
  visit(parse(html, { sourceCodeLocationInfo: true }), true);
  const byStart = (a: HtmlRange, b: HtmlRange) => a.start - b.start;
  return { scripts: scripts.sort(byStart), comments: comments.sort(byStart) };
};

/** HTML formatting elements, which the parser re-creates after misnested end tags. */
const FORMATTING_ELEMENTS = new Set([
  "a", "b", "big", "code", "em", "font", "i", "nobr", "s", "small", "strike", "strong", "tt", "u",
]);

export interface SnapshotOptions {
  /** Drop ASCII whitespace from text and attribute values before comparing. */
  ignoreWhitespace?: boolean;
  /**
   * Leave out formatting elements with no content. After a misnested end tag
   * (`<b><p></b>`), the parser re-creates open formatting elements at the next
   * text, whitespace included, so adding or collapsing whitespace there adds
   * or drops an empty copy. Content never moves.
   */
  ignoreEmptyFormattingElements?: boolean;
  /** Script elements to take out of the structure and collect separately. */
  collectScript?: (script: Element, inTemplate: boolean) => boolean;
}

export interface DomSnapshot {
  /** Elements, attributes, and text in tree order. Comments are left out. */
  structure: string;
  /** Collected scripts as `namespace:attributes:text`, sorted. */
  scripts: string[];
}

const ASCII_WHITESPACE_RE = /[\t\n\f\r ]+/g;

/**
 * What a browser builds from `html`, as comparable strings. Adjacent text
 * merges across removed comments and scripts, the way a page renders it.
 */
export const domSnapshot = (html: string, options: SnapshotOptions = {}): DomSnapshot => {
  const clean = (text: string) => (options.ignoreWhitespace ? text.replace(ASCII_WHITESPACE_RE, "") : text);
  const scripts: string[] = [];
  const out: string[] = [];
  const textOf = (element: Element): string =>
    element.childNodes.map((child) => ("value" in child && child.nodeName === "#text" ? child.value : "")).join("");
  const attributesOf = (element: Element): string =>
    element.attrs.map((attribute) => `${attribute.name}=${JSON.stringify(clean(attribute.value))}`).join(" ");
  const visit = (parent: ParentNode, inTemplate: boolean): void => {
    for (const node of parent.childNodes) {
      if (node.nodeName === "#text" && "value" in node) {
        out.push(clean(node.value));
        continue;
      }
      if (!isElement(node)) continue;
      const namespace = node.namespaceURI === HTML_NAMESPACE ? "html" : node.namespaceURI.split("/").pop();
      if (node.tagName === "script" && options.collectScript?.(node, inTemplate)) {
        scripts.push(`${namespace}:${attributesOf(node)}:${clean(textOf(node))}`);
        continue;
      }
      const openIndex = out.length;
      out.push(`<${namespace}:${node.tagName} ${attributesOf(node)}>`);
      if (isTemplate(node)) visit(node.content, true);
      else visit(node, inTemplate);
      const isEmpty = out.slice(openIndex + 1).every((part) => part === "");
      if (options.ignoreEmptyFormattingElements && isEmpty && namespace === "html" && FORMATTING_ELEMENTS.has(node.tagName)) {
        out.length = openIndex;
        continue;
      }
      out.push(`</${node.tagName}>`);
    }
  };
  visit(parse(html), false);
  return { structure: out.join(""), scripts: scripts.sort() };
};
