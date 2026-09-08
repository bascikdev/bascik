import assert from "node:assert/strict";

export interface HeapSnapshot {
  snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[]; edge_fields: string[]; edge_types: (string[] | string)[]; }; };
  nodes: number[];
  edges: number[];
  strings: string[];
}

export function analyzeRetentionHeap(heap: HeapSnapshot, project: string) {
  const meta = heap.snapshot.meta;
  const nodeWidth = meta.node_fields.length;
  const edgeWidth = meta.edge_fields.length;
  const field = (fields: string[], name: string) => {
    const index = fields.indexOf(name);
    assert(index >= 0, `missing heap field ${name}`);
    return index;
  };
  const nodeType = field(meta.node_fields, "type");
  const nodeName = field(meta.node_fields, "name");
  const selfSize = field(meta.node_fields, "self_size");
  const edgeCount = field(meta.node_fields, "edge_count");
  const edgeType = field(meta.edge_fields, "type");
  const edgeName = field(meta.edge_fields, "name_or_index");
  const edgeTarget = field(meta.edge_fields, "to_node");
  const nodeTypes = meta.node_types[nodeType];
  const edgeTypes = meta.edge_types[edgeType];
  assert(Array.isArray(nodeTypes) && Array.isArray(edgeTypes), "heap type metadata");
  assert.equal(heap.nodes.length % nodeWidth, 0, "heap node alignment");
  assert.equal(heap.edges.length % edgeWidth, 0, "heap edge alignment");
  const count = heap.nodes.length / nodeWidth;
  const starts = new Uint32Array(count + 1);
  const nameOf = (node: number) => heap.strings[heap.nodes[node * nodeWidth + nodeName]];
  const typeOf = (node: number) => nodeTypes[heap.nodes[node * nodeWidth + nodeType]];
  const edgeTypeOf = (edge: number) => edgeTypes[heap.edges[edge + edgeType]];
  const edgeNameOf = (edge: number) => ["element", "hidden"].includes(edgeTypeOf(edge)) ? String(heap.edges[edge + edgeName]) : heap.strings[heap.edges[edge + edgeName]];
  for (let node = 0; node < count; node++) starts[node + 1] = starts[node] + heap.nodes[node * nodeWidth + edgeCount] * edgeWidth;
  assert.equal(starts[count], heap.edges.length, "heap edge cardinality");
  for (let edge = 0; edge < heap.edges.length; edge += edgeWidth) {
    const target = heap.edges[edge + edgeTarget];
    assert(Number.isInteger(target) && target >= 0 && target < heap.nodes.length && target % nodeWidth === 0, "invalid heap edge target");
  }
  const property = (node: number, name: string) => {
    for (let edge = starts[node]; edge < starts[node + 1]; edge += edgeWidth) {
      if (edgeTypeOf(edge) === "property" && edgeNameOf(edge) === name) return heap.edges[edge + edgeTarget] / nodeWidth;
    }
    return undefined;
  };
  const textOf = (node: number, depth = 0): string => {
    if (typeOf(node) !== "concatenated string" || depth > 20) return nameOf(node);
    let text = "";
    for (let edge = starts[node]; edge < starts[node + 1]; edge += edgeWidth) {
      if (["first", "second"].includes(edgeNameOf(edge))) text += textOf(heap.edges[edge + edgeTarget] / nodeWidth, depth + 1);
    }
    return text;
  };
  const classes: Record<string, number> = {};
  const categories: Record<string, { count: number; selfBytes: number; }> = {};
  const loaders: number[] = [];
  const jobs: number[] = [];
  const registries: number[] = [];
  for (let node = 0; node < count; node++) {
    const type = typeOf(node);
    const name = nameOf(node);
    const category = type === "object" && ["Buffer", "ArrayBuffer", "Request", "Response"].includes(name) ? name : type;
    const total = categories[category] ??= { count: 0, selfBytes: 0 };
    total.count++; total.selfBytes += heap.nodes[node * nodeWidth + selfSize];
    if (type === "object" && ["ModuleJob", "ModuleWrap", "Module", "LoadCache", "ScriptRegistry", "MemoryStore"].includes(name)) classes[name] = (classes[name] ?? 0) + 1;
    if (type === "closure" && ["toError", "onAbort", "runStreamJob"].includes(name)) classes[`closure:${name}`] = (classes[`closure:${name}`] ?? 0) + 1;
    if (type === "object" && name === "LoadCache") loaders.push(node);
    if (type === "object" && name === "ModuleJob") jobs.push(node);
    if (type === "object" && name === "ScriptRegistry") registries.push(node);
  }
  const previous = new Int32Array(count).fill(-1);
  const via = new Int32Array(count).fill(-1);
  const depths = new Uint8Array(count);
  const queue = [...loaders];
  for (const loader of loaders) previous[loader] = loader;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor];
    if (depths[node] >= 8) continue;
    for (let edge = starts[node]; edge < starts[node + 1]; edge += edgeWidth) {
      if (["weak", "shortcut"].includes(edgeTypeOf(edge))) continue;
      const target = heap.edges[edge + edgeTarget] / nodeWidth;
      if (previous[target] !== -1) continue;
      previous[target] = node; via[target] = edge; depths[target] = depths[node] + 1; queue.push(target);
    }
  }
  const fixtureJobs: { url: string; path: string[]; }[] = [];
  for (const node of jobs) {
    const urlNode = property(node, "url");
    if (urlNode === undefined) continue;
    const url = textOf(urlNode);
    if (!url.includes(project) && !url.includes("retentionInline129") && !url.includes("retentionShared129")) continue;
    const path: string[] = [];
    if (previous[node] !== -1) {
      let cursor = node;
      while (previous[cursor] !== cursor) {
        path.push(`${edgeTypeOf(via[cursor])}:${edgeNameOf(via[cursor])} -> ${nameOf(cursor)}`);
        cursor = previous[cursor];
      }
      path.push(nameOf(cursor)); path.reverse();
    }
    fixtureJobs.push({ url, path });
  }
  const namespaces = new Set<number>();
  const frameworkPaths: string[][] = [];
  for (const registry of registries) {
    const cache = property(registry, "cache");
    if (cache === undefined) continue;
    for (let cacheEdge = starts[cache]; cacheEdge < starts[cache + 1]; cacheEdge += edgeWidth) {
      if (edgeTypeOf(cacheEdge) !== "internal" || edgeNameOf(cacheEdge) !== "table") continue;
      const table = heap.edges[cacheEdge + edgeTarget] / nodeWidth;
      for (let entryEdge = starts[table]; entryEdge < starts[table + 1]; entryEdge += edgeWidth) {
        if (edgeTypeOf(entryEdge) !== "internal") continue;
        const entry = heap.edges[entryEdge + edgeTarget] / nodeWidth;
        const namespace = property(entry, "module");
        if (namespace === undefined || typeOf(namespace) !== "object" || nameOf(namespace) !== "Module") continue;
        namespaces.add(namespace);
        if (frameworkPaths.length < 3) frameworkPaths.push(["ScriptRegistry", "property:cache -> Map", "internal:table", `internal:${edgeNameOf(entryEdge)} -> Object`, "property:module -> Module"]);
      }
    }
  }
  return { classes, fixtureJobs, categories, frameworkNamespaces: namespaces.size, frameworkPaths };
}