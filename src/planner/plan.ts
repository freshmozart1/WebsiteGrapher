import {
  componentById,
  describeLocator,
  fieldById,
  fieldNamesInUse,
  fieldsNamed,
  goalById,
  pageById,
} from "../graph/query.js";
import type {
  Action,
  FieldNode,
  LocatorDefinition,
  SiteGraph,
} from "../graph/schema.js";
import { findPath, reachablePages, type PathStep } from "./search.js";
import type { Confidence } from "./goals.js";

export type PlanTarget =
  | { kind: "goal"; goalId: string }
  | { kind: "field"; semanticName: string }
  | { kind: "page"; pageId: string };

export interface PlanStep {
  index: number;
  action: Action;
  fromPageId: string;
  toPageId: string;
  locator: LocatorDefinition;
  description: string;
}

export interface PlanOk {
  ok: true;
  question?: string;
  steps: PlanStep[];
  destination: { pageId: string; pageType: string; urlPattern: string };
  field?: {
    id: string;
    semanticName: string;
    locator: LocatorDefinition;
    verified: boolean;
  };
  confidence: Confidence;
  notes: string[];
}

export interface PlanGap {
  ok: false;
  question?: string;
  reason: string;
  detail: string[];
  suggestion: string;
}

export type Plan = PlanOk | PlanGap;

/**
 * Builds a route from the graph's entry page to wherever the answer lives.
 * Pure: same graph and target always yield the same plan.
 */
export function buildPlan(
  graph: SiteGraph,
  target: PlanTarget,
  options: { question?: string; confidence?: Confidence } = {},
): Plan {
  const question = options.question;
  const notes: string[] = [];

  if (graph.pages.length === 0) {
    return {
      ok: false,
      question,
      reason: "The graph for this site is empty.",
      detail: [],
      suggestion: `Learn the site first: wgraph analyze ${graph.origin}`,
    };
  }
  const entry = pageById(graph, graph.entryPageId);
  if (!entry) {
    return {
      ok: false,
      question,
      reason: "The graph has no entry page, so there is nowhere to start.",
      detail: [`entryPageId is "${graph.entryPageId}"`],
      suggestion: "Set one: wgraph graph set-entry <domain> <pageId>",
    };
  }

  const resolved = resolveTarget(graph, target);
  if ("gap" in resolved) return { ...resolved.gap, question };

  // A field can sit on several pages; take whichever is genuinely closest
  // rather than whichever happens to be first in the file.
  let chosen: { pageId: string; field?: FieldNode; path: PathStep[] } | undefined;
  for (const candidate of resolved.candidates) {
    const path = findPath(graph, entry.id, candidate.pageId);
    if (!path) continue;
    if (!chosen || path.length < chosen.path.length) {
      chosen = { pageId: candidate.pageId, field: candidate.field, path };
    }
  }

  if (!chosen) {
    const reachable = reachablePages(graph, entry.id);
    const wanted = resolved.candidates.map((c) => c.pageId);
    return {
      ok: false,
      question,
      reason:
        "The information exists in the graph, but no learned route reaches it.",
      detail: [
        `target page(s): ${wanted.join(", ")}`,
        `reachable from "${entry.id}": ${[...reachable].join(", ")}`,
      ],
      suggestion: `Extend what was learned: wgraph analyze ${graph.origin} --from ${wanted[0] ?? entry.id}`,
    };
  }

  const destination = pageById(graph, chosen.pageId);
  if (!destination) {
    return {
      ok: false,
      question,
      reason: `Page "${chosen.pageId}" is referenced but missing from the graph.`,
      detail: [],
      suggestion: `Re-validate the graph: wgraph graph validate ${graph.origin}`,
    };
  }

  if (chosen.field && !chosen.field.verified) {
    notes.push(
      `The "${chosen.field.semanticName}" position was seen on only one sample page, so it may not hold for every item.`,
    );
  }
  if (chosen.path.length === 0) {
    notes.push("The answer is on the entry page itself — no navigation needed.");
  }

  return {
    ok: true,
    question,
    steps: chosen.path.map((step, i) => toPlanStep(graph, step, i)),
    destination: {
      pageId: destination.id,
      pageType: destination.type,
      urlPattern: destination.urlPattern,
    },
    ...(chosen.field
      ? {
          field: {
            id: chosen.field.id,
            semanticName: chosen.field.semanticName,
            locator: chosen.field.locator,
            verified: chosen.field.verified,
          },
        }
      : {}),
    confidence: options.confidence ?? "high",
    notes,
  };
}

interface Candidate {
  pageId: string;
  field?: FieldNode;
}

function resolveTarget(
  graph: SiteGraph,
  target: PlanTarget,
): { candidates: Candidate[] } | { gap: Omit<PlanGap, "question"> } {
  if (target.kind === "goal") {
    const goal = goalById(graph, target.goalId);
    if (!goal) {
      return {
        gap: {
          ok: false,
          reason: `No goal "${target.goalId}" in this graph.`,
          detail: graph.goals.map((g) => `${g.id}: ${g.name}`),
          suggestion: "List what is known: wgraph graph show <domain>",
        },
      };
    }
    const field = fieldById(graph, goal.targetField);
    return { candidates: [{ pageId: goal.targetPage, ...(field ? { field } : {}) }] };
  }

  if (target.kind === "page") {
    if (!pageById(graph, target.pageId)) {
      return {
        gap: {
          ok: false,
          reason: `No page "${target.pageId}" in this graph.`,
          detail: graph.pages.map((p) => `${p.id} (${p.type})`),
          suggestion: "List what is known: wgraph graph show <domain>",
        },
      };
    }
    return { candidates: [{ pageId: target.pageId }] };
  }

  const fields = fieldsNamed(graph, target.semanticName);
  if (fields.length === 0) {
    const known = fieldNamesInUse(graph);
    return {
      gap: {
        ok: false,
        reason: `Nothing named "${target.semanticName}" was learned on this site.`,
        detail: known.length > 0 ? [`known fields: ${known.join(", ")}`] : [],
        suggestion:
          known.length > 0
            ? `Try one of the known fields, or re-analyze to look for "${target.semanticName}".`
            : `Learn the site first: wgraph analyze ${graph.origin}`,
      },
    };
  }
  // Verified positions first: they held on more than one sample page.
  const ordered = [...fields].sort(
    (a, b) => Number(b.verified) - Number(a.verified),
  );
  return { candidates: ordered.map((f) => ({ pageId: f.pageId, field: f })) };
}

function toPlanStep(graph: SiteGraph, step: PathStep, index: number): PlanStep {
  const to = pageById(graph, step.toPage);
  const source = componentById(graph, step.edge.sourceNode);
  // An edge off a list means "any item in it" — naming one product's selector
  // would be both unreadable and misleadingly specific.
  const what =
    source?.type === "list"
      ? "an item in the list"
      : source
        ? `${describeLocator(step.edge.locator)} in the ${source.type}`
        : describeLocator(step.edge.locator);
  const where = to ? `the ${to.type} page` : step.toPage;
  const description =
    step.edge.action === "navigate"
      ? `Go to ${where} (${to?.urlPattern ?? step.toPage})`
      : `${verb(step.edge.action)} ${what} to reach ${where}`;
  return {
    index: index + 1,
    action: step.edge.action,
    fromPageId: step.fromPage,
    toPageId: step.toPage,
    locator: step.edge.locator,
    description,
  };
}

function verb(action: Action): string {
  switch (action) {
    case "click":
      return "Click";
    case "fill":
      return "Fill in";
    case "select":
      return "Choose an option in";
    case "scroll":
      return "Scroll";
    case "navigate":
      return "Open";
  }
}
