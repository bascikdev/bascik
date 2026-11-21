import { maskLikeCompiler } from "./component-usages.js";
import { scanTags } from "./tag-scan.js";

export interface ComponentMetadataMember {
  name: string;
  description?: string;
}

export interface ComponentMetadataDiagnostic {
  code:
    | "component-metadata-duplicate-annotation"
    | "component-metadata-undeclared-annotation";
  message: string;
  start: number;
  end: number;
}

export interface ComponentMetadata {
  description?: string;
  props: ComponentMetadataMember[];
  slots: ComponentMetadataMember[];
  defaultSlot?: ComponentMetadataMember;
  hasStyles: boolean;
  hasScripts: boolean;
  diagnostics: ComponentMetadataDiagnostic[];
}

export interface AnalyzeComponentSourceOptions {
  hasCompanionStyles?: boolean;
  /**
   * Lowercase names of the project's components. A named slot marker inside
   * one of their usages belongs to that component, not to this template.
   */
  componentNames?: ReadonlySet<string>;
}

interface InferredMember {
  name: string;
  offset: number;
}

interface Annotation {
  kind: "prop" | "slot";
  name: string;
  description?: string;
  start: number;
  end: number;
}

/**
 * Comment bodies and `<script>`, `<style>` and `<textarea>` content blanked,
 * in document order as the compiler reads them: a `<!--` inside a stylesheet
 * or script string is that element's text, and a `<script>` inside a comment
 * opens nothing.
 */
const maskNonMarkup = maskLikeCompiler;

// The build's named wrapper marker (`NAMED_SLOT_MARKER_RE` in pkg's component-slots.ts).
const NAMED_SLOT_ATTRIBUTE =
  /\sdata-bascik-slot\s*=\s*(?:"[^"]+"|'[^']+'|[^\s"'=<>`/>]+)/i;
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * The open tags (`[start, end)`) of named slot markers that declare no slot
 * of this template, read as the build's slot parser (`parseNamedSlots` in
 * pkg's component-slots.ts) reads them: a marker inside a closed component
 * usage belongs to that component, a marker inside a filled wrapper is that
 * wrapper's content, and a marker whose element has no matching end tag (a
 * void element, `<span data-bascik-slot="a"/>` with no `</span>`) is never
 * filled. A component usage with no end tag, or written `<x-card/>`, holds
 * nothing, so a marker after it is still this template's.
 */
function ownedSlotMarkerTags(
  masked: string,
  componentNames: ReadonlySet<string>,
): Array<[number, number]> {
  const owned: Array<[number, number]> = [];
  if (!/data-bascik-slot\s*=/i.test(masked)) return owned;
  const tags = [...scanTags(masked)];
  // The start and end of the end tag matching each start tag, or -1, as the
  // build's close finder matches them (`createMatchingCloseFinder`): the first
  // end tag of the same name that no later start tag of that name takes. A
  // start tag ending in `/>` takes none, but finds its own as any other does.
  const closeStart = new Array<number>(tags.length).fill(-1);
  const closeEnd = new Array<number>(tags.length).fill(-1);
  const open = new Map<string, number[]>();
  const selfClosed = new Map<string, Array<{ tag: number; depth: number }>>();
  for (const [index, tag] of tags.entries()) {
    const name = tag.name.toLowerCase();
    const stack = open.get(name) ?? [];
    open.set(name, stack);
    if (tag.closing) {
      const depth = stack.length;
      const matched = stack.pop();
      if (matched !== undefined) {
        closeStart[matched] = tag.start;
        closeEnd[matched] = tag.end;
      }
      const waiting = selfClosed.get(name);
      while (waiting && waiting.length > 0 && waiting.at(-1)!.depth >= depth) {
        const { tag: waiter } = waiting.pop()!;
        closeStart[waiter] = tag.start;
        closeEnd[waiter] = tag.end;
      }
      continue;
    }
    if (VOID_ELEMENTS.has(name)) continue;
    if (/\/\s*>$/.test(tag.text)) {
      const waiting = selfClosed.get(name) ?? [];
      selfClosed.set(name, waiting);
      waiting.push({ tag: index, depth: stack.length });
      continue;
    }
    stack.push(index);
  }
  // The parser's walk: wrappers in order, skipping the content of each one it
  // fills and every marker inside a closed component usage.
  let insideUntil = -1;
  let filledUntil = 0;
  for (const [index, tag] of tags.entries()) {
    if (tag.closing) continue;
    if (NAMED_SLOT_ATTRIBUTE.test(tag.text)) {
      if (
        tag.start < filledUntil ||
        tag.start < insideUntil ||
        closeStart[index] === -1
      )
        owned.push([tag.start, tag.end]);
      else filledUntil = closeEnd[index];
    }
    // A usage's content starts after its start tag, so the usage's own
    // marker is still read above.
    if (
      componentNames.has(tag.name.toLowerCase()) &&
      !/\/\s*>$/.test(tag.text) &&
      closeStart[index] !== -1
    )
      insideUntil = Math.max(insideUntil, closeStart[index]);
  }
  return owned;
}

function inferMembers(
  source: string,
  componentNames: ReadonlySet<string> = new Set(),
): {
  props: InferredMember[];
  slots: InferredMember[];
  hasDefaultSlot: boolean;
} {
  const masked = maskNonMarkup(source);
  const owned = ownedSlotMarkerTags(masked, componentNames);
  let ownedAt = 0;
  const propOffsets = new Map<string, InferredMember>();
  const slots: InferredMember[] = [];
  const seenSlots = new Set<string>();
  let hasDefaultSlot = false;

  const add = (
    members: InferredMember[],
    seen: Set<string>,
    name: string,
    offset: number,
  ) => {
    const normalized = name.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    members.push({ name, offset });
  };

  for (const match of masked.matchAll(/data-bascik-prop-([\w-]+)/gi)) {
    const name = match[1];
    if (name) {
      const normalized = name.toLowerCase();
      const offset = (match.index ?? 0) + match[0].lastIndexOf(name);
      const previous = propOffsets.get(normalized);
      if (!previous || offset < previous.offset)
        propOffsets.set(normalized, { name, offset });
    }
  }

  for (const match of masked.matchAll(
    // The prop a data-bascik-attr-* binding reads. (No other data-bascik-* attribute takes a prop name.)
    /data-bascik-attr-[\w:.-]+\s*=\s*(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))/gi,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) {
      const normalized = name.toLowerCase();
      const offset = (match.index ?? 0) + match[0].lastIndexOf(name);
      const previous = propOffsets.get(normalized);
      if (!previous || offset < previous.offset)
        propOffsets.set(normalized, { name, offset });
    }
  }

  const slotRegex =
    /data-bascik-slot(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`/>]+)))?/gi;
  for (const match of masked.matchAll(slotRegex)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name === undefined || name.trim() === "") {
      hasDefaultSlot = true;
      continue;
    }
    const index = match.index ?? 0;
    while (ownedAt < owned.length && owned[ownedAt][1] <= index) ownedAt++;
    if (ownedAt < owned.length && owned[ownedAt][0] <= index) continue;
    const trimmed = name.trim();
    add(
      slots,
      seenSlots,
      trimmed,
      (match.index ?? 0) + match[0].lastIndexOf(trimmed),
    );
  }

  const props = [...propOffsets.values()].sort(
    (left, right) => left.offset - right.offset,
  );
  slots.sort((left, right) => left.offset - right.offset);
  return { props, slots, hasDefaultSlot };
}

function findMetadataComment(
  source: string,
): { body: string; bodyStart: number } | undefined {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (offset < source.length) {
    const whitespace = /^\s*/.exec(source.slice(offset))?.[0] ?? "";
    offset += whitespace.length;
    if (!source.startsWith("<!--", offset)) return undefined;
    const close = source.indexOf("-->", offset + 4);
    if (close < 0) return undefined;
    const bodyStart = offset + 4;
    const body = source.slice(bodyStart, close);
    if (/^\s*@bascik(?:\s|$)/.test(body)) return { body, bodyStart };
    offset = close + 3;
  }
  return undefined;
}

function parseMetadataComment(source: string): {
  description?: string;
  annotations: Annotation[];
} {
  const comment = findMetadataComment(source);
  if (!comment) return { annotations: [] };

  const marker = /^\s*@bascik[^\S\r\n]*(?:\r?\n|$)/.exec(comment.body);
  if (!marker) return { annotations: [] };
  const contentStart = marker[0].length;
  const content = comment.body.slice(contentStart);
  const annotations: Annotation[] = [];
  const descriptionLines: string[] = [];
  const lineRegex = /.*(?:\r?\n|$)/g;

  for (const lineMatch of content.matchAll(lineRegex)) {
    const rawLine = lineMatch[0].replace(/\r?\n$/, "");
    if (!rawLine && (lineMatch.index ?? 0) === content.length) continue;
    const cleaned = rawLine.replace(/^\s*\*?\s?/, "").trimEnd();
    const annotationMatch = /^@(prop|slot)\s+([\w-]+)(?:\s+-\s*(.*))?\s*$/.exec(
      cleaned,
    );
    if (annotationMatch) {
      const name = annotationMatch[2];
      const rawNameOffset = rawLine.indexOf(name);
      const start =
        comment.bodyStart +
        contentStart +
        (lineMatch.index ?? 0) +
        Math.max(rawNameOffset, 0);
      annotations.push({
        kind: annotationMatch[1] as "prop" | "slot",
        name,
        description: annotationMatch[3]?.trim() || undefined,
        start,
        end: start + name.length,
      });
    } else if (cleaned && !cleaned.startsWith("@")) {
      descriptionLines.push(cleaned);
    }
  }

  return {
    description: descriptionLines.join(" ").trim() || undefined,
    annotations,
  };
}

export function analyzeComponentSource(
  source: string,
  options: AnalyzeComponentSourceOptions = {},
): ComponentMetadata {
  const inferred = inferMembers(source, options.componentNames);
  const documented = parseMetadataComment(source);
  const props: ComponentMetadataMember[] = inferred.props.map(({ name }) => ({
    name,
  }));
  const slots: ComponentMetadataMember[] = inferred.slots.map(({ name }) => ({
    name,
  }));
  const defaultSlot: ComponentMetadataMember | undefined =
    inferred.hasDefaultSlot ? { name: "default" } : undefined;
  const diagnostics: ComponentMetadataDiagnostic[] = [];
  const seenAnnotations = new Set<string>();

  for (const annotation of documented.annotations) {
    const key = `${annotation.kind}:${annotation.name.toLowerCase()}`;
    if (seenAnnotations.has(key)) {
      diagnostics.push({
        code: "component-metadata-duplicate-annotation",
        message: `Duplicate @${annotation.kind} annotation for "${annotation.name}". The first annotation is used.`,
        start: annotation.start,
        end: annotation.end,
      });
      continue;
    }
    seenAnnotations.add(key);

    const member =
      annotation.kind === "prop"
        ? props.find(
            (candidate) =>
              candidate.name.toLowerCase() === annotation.name.toLowerCase(),
          )
        : annotation.name.toLowerCase() === "default"
          ? defaultSlot
          : slots.find(
              (candidate) =>
                candidate.name.toLowerCase() === annotation.name.toLowerCase(),
            );
    if (!member) {
      diagnostics.push({
        code: "component-metadata-undeclared-annotation",
        message: `@${annotation.kind} annotation "${annotation.name}" does not match a ${annotation.kind === "prop" ? "prop" : "slot"} declared in this component's markup.`,
        start: annotation.start,
        end: annotation.end,
      });
      continue;
    }
    member.description = annotation.description;
  }

  return {
    description: documented.description,
    props,
    slots,
    defaultSlot,
    hasStyles:
      options.hasCompanionStyles === true ||
      /<style(?=[\t\n\f\r />])/i.test(source),
    hasScripts: /<script(?=[\t\n\f\r />])/i.test(source),
    diagnostics,
  };
}
