import { z } from "zod";
import {
  ActionSchema,
  ComponentMetaSchema,
  LocatorDefinitionSchema,
  ProbeCandidateSchema,
  StateDimensionSchema,
  VOCAB_KINDS,
  type SiteGraph,
  type VocabKind,
} from "./schema.js";

/**
 * Every write goes through a patch. Patches are applied to an in-memory graph
 * and the whole graph is re-validated before it reaches disk, so a patch can
 * never leave the graph referentially broken.
 */

const vocabAddition = z.object({
  name: z.string(),
  description: z.string().min(1),
});

const pageInput = z.object({
  id: z.string().optional(),
  type: z.string(),
  urlPattern: z.string(),
  components: z.array(z.string()).optional(),
  stateDimensions: z.array(StateDimensionSchema).optional(),
  /** Marks this page as where plans start. */
  entry: z.boolean().optional(),
});

const componentInput = z.object({
  id: z.string().optional(),
  pageId: z.string(),
  type: z.string(),
  locator: LocatorDefinitionSchema,
  meta: ComponentMetaSchema.optional(),
});

const edgeInput = z.object({
  id: z.string().optional(),
  sourceNode: z.string(),
  targetNode: z.string(),
  action: ActionSchema,
  locator: LocatorDefinitionSchema,
});

const fieldInput = z.object({
  id: z.string().optional(),
  pageId: z.string(),
  semanticName: z.string(),
  locator: LocatorDefinitionSchema,
  verified: z.boolean().optional(),
  valueShape: z.enum(["currency", "text", "url", "number"]).optional(),
});

const goalInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  targetField: z.string(),
  targetPage: z.string(),
});

export const GraphPatchSchema = z.object({
  entryPageId: z.string().optional(),
  vocabulary: z
    .object({
      pageTypes: z.array(vocabAddition).optional(),
      componentTypes: z.array(vocabAddition).optional(),
      fieldNames: z.array(vocabAddition).optional(),
    })
    .optional(),
  pages: z.array(pageInput).optional(),
  components: z.array(componentInput).optional(),
  edges: z.array(edgeInput).optional(),
  fields: z.array(fieldInput).optional(),
  goals: z.array(goalInput).optional(),
  pendingApprovals: z.array(ProbeCandidateSchema).optional(),
  /** Ids of approvals that have been decided and should leave the queue. */
  resolveApprovals: z.array(z.string()).optional(),
});

export type GraphPatch = z.infer<typeof GraphPatchSchema>;

export class VocabularyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VocabularyError";
  }
}

const KIND_BY_ALIAS: Record<string, VocabKind> = {
  page: "pageTypes",
  pageTypes: "pageTypes",
  component: "componentTypes",
  componentTypes: "componentTypes",
  field: "fieldNames",
  fieldNames: "fieldNames",
};

export function resolveVocabKind(alias: string): VocabKind {
  const kind = KIND_BY_ALIAS[alias];
  if (!kind) {
    throw new VocabularyError(
      `Unknown vocabulary kind "${alias}". Use one of: page, component, field.`,
    );
  }
  return kind;
}

/**
 * Registering a value is an explicit act, not a side effect of writing a node.
 * That is the whole point: adding a page type is a decision, and it should be
 * visible as one.
 */
export function registerVocab(
  graph: SiteGraph,
  kind: VocabKind,
  name: string,
  description: string,
): { added: boolean } {
  const existing = graph.vocabulary[kind].find((e) => e.name === name);
  if (existing) return { added: false };
  graph.vocabulary[kind].push({ name, description, builtin: false });
  graph.vocabulary[kind].sort((a, b) => a.name.localeCompare(b.name));
  return { added: true };
}

export function isRegistered(
  graph: SiteGraph,
  kind: VocabKind,
  name: string,
): boolean {
  return graph.vocabulary[kind].some((e) => e.name === name);
}

/** Builtin values are permanent, so nothing already written against them breaks. */
export function unregisterVocab(
  graph: SiteGraph,
  kind: VocabKind,
  name: string,
): void {
  const entry = graph.vocabulary[kind].find((e) => e.name === name);
  if (!entry) throw new VocabularyError(`"${name}" is not registered in ${kind}`);
  if (entry.builtin) {
    throw new VocabularyError(`"${name}" is a builtin ${kind} value and cannot be removed`);
  }
  const inUse = usageCount(graph, kind, name);
  if (inUse > 0) {
    throw new VocabularyError(
      `"${name}" is still used by ${inUse} node(s); retype them before removing it`,
    );
  }
  graph.vocabulary[kind] = graph.vocabulary[kind].filter((e) => e.name !== name);
}

export function usageCount(
  graph: SiteGraph,
  kind: VocabKind,
  name: string,
): number {
  switch (kind) {
    case "pageTypes":
      return graph.pages.filter((p) => p.type === name).length;
    case "componentTypes":
      return graph.components.filter((c) => c.type === name).length;
    case "fieldNames":
      return graph.fields.filter((f) => f.semanticName === name).length;
  }
}

/** Every value in use, grouped, for `wgraph graph show --vocabulary`. */
export function vocabularyReport(graph: SiteGraph) {
  return VOCAB_KINDS.map((kind) => ({
    kind,
    entries: graph.vocabulary[kind].map((e) => ({
      ...e,
      inUse: usageCount(graph, kind, e.name),
    })),
  }));
}

function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "node"
  );
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function allIds(graph: SiteGraph): Set<string> {
  return new Set([
    ...graph.pages.map((p) => p.id),
    ...graph.components.map((c) => c.id),
    ...graph.fields.map((f) => f.id),
    ...graph.edges.map((e) => e.id),
    ...graph.goals.map((g) => g.id),
  ]);
}

/**
 * Apply a patch in place. Ids may be supplied explicitly so a patch can
 * reference nodes it creates in the same call; otherwise readable ids are
 * generated. The caller re-validates the whole graph before saving.
 */
export function applyPatch(graph: SiteGraph, patch: GraphPatch): void {
  const taken = allIds(graph);
  const now = new Date().toISOString();

  for (const kind of VOCAB_KINDS) {
    for (const add of patch.vocabulary?.[kind] ?? []) {
      registerVocab(graph, kind, add.name, add.description);
    }
  }

  for (const p of patch.pages ?? []) {
    const id = uniqueId(p.id ?? `page-${slug(p.type)}`, taken);
    graph.pages.push({
      id,
      type: p.type,
      urlPattern: p.urlPattern,
      components: p.components ?? [],
      ...(p.stateDimensions ? { stateDimensions: p.stateDimensions } : {}),
      learnedAt: now,
    });
    if (p.entry) graph.entryPageId = id;
  }

  for (const c of patch.components ?? []) {
    const id = uniqueId(c.id ?? `comp-${slug(c.type)}-${slug(c.pageId)}`, taken);
    graph.components.push({
      id,
      pageId: c.pageId,
      type: c.type,
      locator: c.locator,
      ...(c.meta ? { meta: c.meta } : {}),
    });
    // Keep the page's component list in step so callers never have to.
    const page = graph.pages.find((p) => p.id === c.pageId);
    if (page && !page.components.includes(id)) page.components.push(id);
  }

  for (const e of patch.edges ?? []) {
    const id = uniqueId(
      e.id ?? `edge-${slug(e.sourceNode)}-to-${slug(e.targetNode)}`,
      taken,
    );
    graph.edges.push({
      id,
      sourceNode: e.sourceNode,
      targetNode: e.targetNode,
      action: e.action,
      locator: e.locator,
    });
  }

  for (const f of patch.fields ?? []) {
    const id = uniqueId(
      f.id ?? `field-${slug(f.semanticName)}-${slug(f.pageId)}`,
      taken,
    );
    graph.fields.push({
      id,
      pageId: f.pageId,
      semanticName: f.semanticName,
      locator: f.locator,
      verified: f.verified ?? false,
      ...(f.valueShape ? { valueShape: f.valueShape } : {}),
    });
  }

  for (const g of patch.goals ?? []) {
    const id = uniqueId(g.id ?? `goal-${slug(g.name)}`, taken);
    graph.goals.push({
      id,
      name: g.name,
      targetField: g.targetField,
      targetPage: g.targetPage,
    });
  }

  for (const a of patch.pendingApprovals ?? []) {
    if (!graph.pendingApprovals.some((p) => p.id === a.id)) {
      graph.pendingApprovals.push(a);
    }
  }

  if (patch.resolveApprovals?.length) {
    const done = new Set(patch.resolveApprovals);
    graph.pendingApprovals = graph.pendingApprovals.filter((a) => !done.has(a.id));
  }

  if (patch.entryPageId) graph.entryPageId = patch.entryPageId;

  graph.learnedAt = now;
}
