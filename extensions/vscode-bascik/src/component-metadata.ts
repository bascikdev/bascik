export interface ComponentMetadataMember {
  name: string;
  description?: string;
}

export interface ComponentMetadataDiagnostic {
  code:
    | 'component-metadata-duplicate-annotation'
    | 'component-metadata-undeclared-annotation';
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
}

interface InferredMember {
  name: string;
  offset: number;
}

interface Annotation {
  kind: 'prop' | 'slot';
  name: string;
  description?: string;
  start: number;
  end: number;
}

function maskNonMarkup(source: string): string {
  return source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (match) => ' '.repeat(match.length))
    .replace(
      /(<(script|style|textarea)\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/\2\s*>)/gi,
      (_match, openTag: string, _name: string, body: string, closeTag: string) =>
        `${openTag}${' '.repeat(body.length)}${closeTag}`,
    );
}

function inferMembers(source: string): {
  props: InferredMember[];
  slots: InferredMember[];
  hasDefaultSlot: boolean;
} {
  const masked = maskNonMarkup(source);
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
      if (!previous || offset < previous.offset) propOffsets.set(normalized, { name, offset });
    }
  }

  for (const match of masked.matchAll(
    /data-bascik-(?:attr-[\w:.-]+|text|html)\s*=\s*(?:"([\w-]+)"|'([\w-]+)')/gi,
  )) {
    const name = match[1] ?? match[2];
    if (name) {
      const normalized = name.toLowerCase();
      const offset = (match.index ?? 0) + match[0].lastIndexOf(name);
      const previous = propOffsets.get(normalized);
      if (!previous || offset < previous.offset) propOffsets.set(normalized, { name, offset });
    }
  }

  const slotRegex = /data-bascik-slot(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gi;
  for (const match of masked.matchAll(slotRegex)) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name === undefined || name.trim() === '') {
      hasDefaultSlot = true;
      continue;
    }
    const trimmed = name.trim();
    add(slots, seenSlots, trimmed, (match.index ?? 0) + match[0].lastIndexOf(trimmed));
  }

  const props = [...propOffsets.values()].sort((left, right) => left.offset - right.offset);
  slots.sort((left, right) => left.offset - right.offset);
  return { props, slots, hasDefaultSlot };
}

function findMetadataComment(source: string): { body: string; bodyStart: number } | undefined {
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (offset < source.length) {
    const whitespace = /^\s*/.exec(source.slice(offset))?.[0] ?? '';
    offset += whitespace.length;
    if (!source.startsWith('<!--', offset)) return undefined;
    const close = source.indexOf('-->', offset + 4);
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
    const rawLine = lineMatch[0].replace(/\r?\n$/, '');
    if (!rawLine && (lineMatch.index ?? 0) === content.length) continue;
    const cleaned = rawLine.replace(/^\s*\*?\s?/, '').trimEnd();
    const annotationMatch = /^@(prop|slot)\s+([\w-]+)(?:\s+-\s*(.*))?\s*$/.exec(cleaned);
    if (annotationMatch) {
      const name = annotationMatch[2];
      const rawNameOffset = rawLine.indexOf(name);
      const start = comment.bodyStart + contentStart + (lineMatch.index ?? 0) + Math.max(rawNameOffset, 0);
      annotations.push({
        kind: annotationMatch[1] as 'prop' | 'slot',
        name,
        description: annotationMatch[3]?.trim() || undefined,
        start,
        end: start + name.length,
      });
    } else if (cleaned && !cleaned.startsWith('@')) {
      descriptionLines.push(cleaned);
    }
  }

  return {
    description: descriptionLines.join(' ').trim() || undefined,
    annotations,
  };
}

export function analyzeComponentSource(
  source: string,
  options: AnalyzeComponentSourceOptions = {},
): ComponentMetadata {
  const inferred = inferMembers(source);
  const documented = parseMetadataComment(source);
  const props: ComponentMetadataMember[] = inferred.props.map(({ name }) => ({ name }));
  const slots: ComponentMetadataMember[] = inferred.slots.map(({ name }) => ({ name }));
  const defaultSlot: ComponentMetadataMember | undefined = inferred.hasDefaultSlot
    ? { name: 'default' }
    : undefined;
  const diagnostics: ComponentMetadataDiagnostic[] = [];
  const seenAnnotations = new Set<string>();

  for (const annotation of documented.annotations) {
    const key = `${annotation.kind}:${annotation.name.toLowerCase()}`;
    if (seenAnnotations.has(key)) {
      diagnostics.push({
        code: 'component-metadata-duplicate-annotation',
        message: `Duplicate @${annotation.kind} annotation for "${annotation.name}". The first annotation is used.`,
        start: annotation.start,
        end: annotation.end,
      });
      continue;
    }
    seenAnnotations.add(key);

    const member =
      annotation.kind === 'prop'
        ? props.find((candidate) => candidate.name.toLowerCase() === annotation.name.toLowerCase())
        : annotation.name.toLowerCase() === 'default'
          ? defaultSlot
          : slots.find((candidate) => candidate.name.toLowerCase() === annotation.name.toLowerCase());
    if (!member) {
      diagnostics.push({
        code: 'component-metadata-undeclared-annotation',
        message: `@${annotation.kind} annotation "${annotation.name}" does not match a ${annotation.kind === 'prop' ? 'prop' : 'slot'} declared in this component's markup.`,
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
    hasStyles: options.hasCompanionStyles === true || /<style\b/i.test(source),
    hasScripts: /<script\b/i.test(source),
    diagnostics,
  };
}
