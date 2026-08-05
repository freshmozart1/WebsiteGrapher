import { z } from "zod";

/**
 * The graph describes only the structure of a website — never its content.
 *
 * Three vocabularies (page types, component types, field names) are open
 * strings rather than closed enums, because no fixed list covers the whole web.
 * They are kept queryable by a registry stored inside the graph: every value in
 * use must be registered with a description, and validation rejects anything
 * that is not. See `Vocabulary` below.
 */

export const SCHEMA_VERSION = 1;

/** Registered vocabulary values are kebab-case so a graph never accumulates
 *  `productList` and `product-list` as separate types. */
const VOCAB_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const vocabName = z
  .string()
  .regex(VOCAB_NAME, "must be kebab-case (e.g. 'checkout-step')");

const nonEmpty = z.string().min(1);

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

/**
 * A ranked hint set, not a set of alternatives. Populate every hint that
 * resolves; resolution always follows RESOLUTION_ORDER. Keeping all of them is
 * what lets a later repair pass fall through to the next hint when a site
 * changes, without re-learning the page.
 */
export const LocatorDefinitionSchema = z
  .object({
    role: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    text: z.string().optional(),
    css: z.string().optional(),
    xpath: z.string().optional(),
  })
  .refine(
    (l) => Object.values(l).some((v) => typeof v === "string" && v.length > 0),
    { message: "locator must carry at least one hint" },
  );

export type LocatorDefinition = z.infer<typeof LocatorDefinitionSchema>;

export const RESOLUTION_ORDER = [
  "role",
  "label",
  "placeholder",
  "text",
  "css",
  "xpath",
] as const;

/**
 * Hints that identify an element by the value it happens to display. A field
 * locator must never use these: `text: "£51.77"` would pin the price field to
 * one product. Structural hints only.
 */
const VALUE_BEARING_HINTS = ["text", "name"] as const;

export function isStructuralLocator(l: LocatorDefinition): boolean {
  return VALUE_BEARING_HINTS.every((h) => !l[h]);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const VocabEntrySchema = z.object({
  name: vocabName,
  /** One line, written when the value is registered. Precise enough that a
   *  later run reaches the same choice instead of inventing a synonym. */
  description: nonEmpty,
  builtin: z.boolean(),
});

export type VocabEntry = z.infer<typeof VocabEntrySchema>;

export const VocabularySchema = z.object({
  pageTypes: z.array(VocabEntrySchema),
  componentTypes: z.array(VocabEntrySchema),
  fieldNames: z.array(VocabEntrySchema),
});

export type Vocabulary = z.infer<typeof VocabularySchema>;
export type VocabKind = keyof Vocabulary;

export const VOCAB_KINDS: VocabKind[] = [
  "pageTypes",
  "componentTypes",
  "fieldNames",
];

/** Seeded values. Always present, never removable, so anything already written
 *  against them keeps working. */
export const BUILTIN_VOCABULARY: Vocabulary = {
  pageTypes: [
    { name: "home", description: "Site entry point / landing page", builtin: true },
    { name: "overview", description: "Lists many items of one kind", builtin: true },
    { name: "detail", description: "Shows one item in full", builtin: true },
    { name: "form", description: "Primarily collects input from the user", builtin: true },
    { name: "search", description: "Search entry or search results", builtin: true },
  ],
  componentTypes: [
    { name: "list", description: "Repeating set of comparable items", builtin: true },
    { name: "filter", description: "Control that narrows or reorders a list", builtin: true },
    { name: "pagination", description: "Control that reveals further items", builtin: true },
    { name: "table", description: "Tabular data with rows and columns", builtin: true },
    { name: "gallery", description: "Repeating set of images or media", builtin: true },
    { name: "button", description: "Standalone control that triggers an action", builtin: true },
  ],
  fieldNames: [
    { name: "title", description: "Primary name of the item", builtin: true },
    { name: "price", description: "Monetary cost of the item", builtin: true },
    { name: "description", description: "Prose describing the item", builtin: true },
    { name: "image", description: "Primary visual representation of the item", builtin: true },
  ],
};

export function freshVocabulary(): Vocabulary {
  return structuredClone(BUILTIN_VOCABULARY);
}

// ---------------------------------------------------------------------------
// Nodes and edges
// ---------------------------------------------------------------------------

export const StateDimensionSchema = z.object({
  id: nonEmpty,
  kind: z.enum(["filter", "sort", "pagination", "search"]),
  componentId: nonEmpty,
  /** Where the values come from — not the values themselves. */
  valueSource: z.enum(["options", "free-text", "numeric"]),
  /** The control's own label, e.g. "Category". Structural, not page content. */
  label: z.string().optional(),
});

export type StateDimension = z.infer<typeof StateDimensionSchema>;

export const PageNodeSchema = z.object({
  id: nonEmpty,
  /** Open vocabulary — must be registered in `vocabulary.pageTypes`. */
  type: vocabName,
  /** Derived pattern such as `/catalogue/:slug`, never a list of visited URLs. */
  urlPattern: nonEmpty,
  components: z.array(nonEmpty),
  stateDimensions: z.array(StateDimensionSchema).optional(),
  learnedAt: nonEmpty,
});

export type PageNode = z.infer<typeof PageNodeSchema>;

export const ComponentMetaSchema = z.object({
  /** A list needs three locators: the container, one item, and the thing you
   *  click inside an item to reach its detail page. */
  itemLocator: LocatorDefinitionSchema.optional(),
  clickTargetLocator: LocatorDefinitionSchema.optional(),
  paginationMode: z
    .enum(["numbered", "next", "load-more", "infinite-scroll"])
    .optional(),
  controlKind: z
    .enum(["checkbox", "select", "search", "tab", "radio", "button"])
    .optional(),
});

export type ComponentMeta = z.infer<typeof ComponentMetaSchema>;

export const ComponentNodeSchema = z.object({
  id: nonEmpty,
  pageId: nonEmpty,
  /** Open vocabulary — must be registered in `vocabulary.componentTypes`. */
  type: vocabName,
  locator: LocatorDefinitionSchema,
  meta: ComponentMetaSchema.optional(),
});

export type ComponentNode = z.infer<typeof ComponentNodeSchema>;

/** Closed on purpose: this mirrors what Playwright can actually do, and the
 *  planner's edge weights are defined per action. */
export const ActionSchema = z.enum([
  "click",
  "fill",
  "select",
  "scroll",
  "navigate",
]);

export type Action = z.infer<typeof ActionSchema>;

export const ActionEdgeSchema = z.object({
  id: nonEmpty,
  /** A page or a component. */
  sourceNode: nonEmpty,
  /** Always a page: edges model navigation. In-page state changes are
   *  `stateDimensions`, not edges. */
  targetNode: nonEmpty,
  action: ActionSchema,
  locator: LocatorDefinitionSchema,
});

export type ActionEdge = z.infer<typeof ActionEdgeSchema>;

export const FieldNodeSchema = z.object({
  id: nonEmpty,
  pageId: nonEmpty,
  /** Open vocabulary — must be registered in `vocabulary.fieldNames`. */
  semanticName: vocabName,
  locator: LocatorDefinitionSchema,
  /** True once the locator resolved uniquely on at least two sample pages of
   *  the same type. Unverified fields are kept but never planned against. */
  verified: z.boolean(),
  /** The shape of what sits there — never the value itself. */
  valueShape: z.enum(["currency", "text", "url", "number"]).optional(),
});

export type FieldNode = z.infer<typeof FieldNodeSchema>;

export const GoalSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
  targetField: nonEmpty,
  targetPage: nonEmpty,
});

export type Goal = z.infer<typeof GoalSchema>;

export const ProbeCandidateSchema = z.object({
  id: nonEmpty,
  pageId: nonEmpty,
  locator: LocatorDefinitionSchema,
  /** Human-readable, for the approval checkpoint: "button labelled 'Sort by'". */
  description: nonEmpty,
  risk: z.enum(["safe", "confirm", "blocked"]),
  /** Why it was tiered that way, so an approval decision is informed. */
  reason: nonEmpty,
  observedAt: nonEmpty,
});

export type ProbeCandidate = z.infer<typeof ProbeCandidateSchema>;

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

const SiteGraphShape = z.object({
  schemaVersion: z.number().int().positive(),
  origin: nonEmpty,
  learnedAt: nonEmpty,
  /** Where every plan starts. Explicit, so nothing has to look for a page
   *  whose type happens to be "home" — the planner never reads type strings.
   *  Empty only on a graph that has not learned a page yet; once `pages` is
   *  non-empty, validation requires it to name one of them. */
  entryPageId: z.string(),
  vocabulary: VocabularySchema,
  pages: z.array(PageNodeSchema),
  components: z.array(ComponentNodeSchema),
  edges: z.array(ActionEdgeSchema),
  fields: z.array(FieldNodeSchema),
  goals: z.array(GoalSchema),
  pendingApprovals: z.array(ProbeCandidateSchema),
});

export type SiteGraph = z.infer<typeof SiteGraphShape>;

/**
 * Full graph validation: shape, vocabulary registration, and referential
 * integrity. This is what gives `wgraph graph validate` teeth — a typo becomes
 * an error instead of a second near-duplicate type nobody notices.
 */
export const SiteGraphSchema = SiteGraphShape.superRefine((g, ctx) => {
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  const registered = (kind: VocabKind) =>
    new Set(g.vocabulary[kind].map((e) => e.name));

  const pageTypes = registered("pageTypes");
  const componentTypes = registered("componentTypes");
  const fieldNames = registered("fieldNames");

  const pageIds = new Set(g.pages.map((p) => p.id));
  const componentIds = new Set(g.components.map((c) => c.id));
  const fieldIds = new Set(g.fields.map((f) => f.id));

  // Unique ids across every collection: ids are referenced interchangeably by
  // edges, so a collision would silently reroute a plan.
  const seen = new Map<string, string>();
  const claim = (id: string, where: string, path: (string | number)[]) => {
    const prior = seen.get(id);
    if (prior) fail(path, `duplicate id "${id}" (already used by ${prior})`);
    else seen.set(id, where);
  };
  g.pages.forEach((p, i) => claim(p.id, "a page", ["pages", i, "id"]));
  g.components.forEach((c, i) => claim(c.id, "a component", ["components", i, "id"]));
  g.fields.forEach((f, i) => claim(f.id, "a field", ["fields", i, "id"]));
  g.edges.forEach((e, i) => claim(e.id, "an edge", ["edges", i, "id"]));
  g.goals.forEach((go, i) => claim(go.id, "a goal", ["goals", i, "id"]));

  if (g.pages.length > 0 && !pageIds.has(g.entryPageId)) {
    fail(["entryPageId"], `entryPageId "${g.entryPageId}" is not a known page`);
  }

  g.pages.forEach((p, i) => {
    if (!pageTypes.has(p.type)) {
      fail(
        ["pages", i, "type"],
        `page type "${p.type}" is not registered; add it with ` +
          `\`wgraph graph add-type page ${p.type} --description "..."\``,
      );
    }
    p.components.forEach((cid, j) => {
      if (!componentIds.has(cid)) {
        fail(["pages", i, "components", j], `unknown component "${cid}"`);
      }
    });
  });

  g.components.forEach((c, i) => {
    if (!componentTypes.has(c.type)) {
      fail(
        ["components", i, "type"],
        `component type "${c.type}" is not registered; add it with ` +
          `\`wgraph graph add-type component ${c.type} --description "..."\``,
      );
    }
    if (!pageIds.has(c.pageId)) {
      fail(["components", i, "pageId"], `unknown page "${c.pageId}"`);
    }
  });

  g.fields.forEach((f, i) => {
    if (!fieldNames.has(f.semanticName)) {
      fail(
        ["fields", i, "semanticName"],
        `field name "${f.semanticName}" is not registered; add it with ` +
          `\`wgraph graph add-type field ${f.semanticName} --description "..."\``,
      );
    }
    if (!pageIds.has(f.pageId)) {
      fail(["fields", i, "pageId"], `unknown page "${f.pageId}"`);
    }
    // A field pinned by displayed text is pinned to one item's value, which is
    // both content and wrong for every other item of the same type.
    if (!isStructuralLocator(f.locator)) {
      fail(
        ["fields", i, "locator"],
        "field locators must be structural: text/name hints identify a value, not a position",
      );
    }
  });

  g.edges.forEach((e, i) => {
    if (!pageIds.has(e.sourceNode) && !componentIds.has(e.sourceNode)) {
      fail(["edges", i, "sourceNode"], `unknown node "${e.sourceNode}"`);
    }
    if (!pageIds.has(e.targetNode)) {
      fail(
        ["edges", i, "targetNode"],
        `edge target "${e.targetNode}" must be a page`,
      );
    }
  });

  g.goals.forEach((go, i) => {
    if (!fieldIds.has(go.targetField)) {
      fail(["goals", i, "targetField"], `unknown field "${go.targetField}"`);
    }
    if (!pageIds.has(go.targetPage)) {
      fail(["goals", i, "targetPage"], `unknown page "${go.targetPage}"`);
    }
  });

  g.pages.forEach((p, i) =>
    (p.stateDimensions ?? []).forEach((d, j) => {
      if (!componentIds.has(d.componentId)) {
        fail(
          ["pages", i, "stateDimensions", j, "componentId"],
          `unknown component "${d.componentId}"`,
        );
      }
    }),
  );
});

/** The planner's runtime type: a concrete state of a page, produced inside a
 *  plan. Deliberately not stored — enumerating filter x sort x page
 *  combinations explodes, so the graph stores `stateDimensions` instead. */
export const PageStateSchema = z.object({
  pageId: nonEmpty,
  filters: z.record(z.unknown()),
  sorting: z.string().optional(),
  pagination: z.number().optional(),
});

export type PageState = z.infer<typeof PageStateSchema>;

export function emptyGraph(origin: string, now = new Date()): SiteGraph {
  return {
    schemaVersion: SCHEMA_VERSION,
    origin,
    learnedAt: now.toISOString(),
    entryPageId: "",
    vocabulary: freshVocabulary(),
    pages: [],
    components: [],
    edges: [],
    fields: [],
    goals: [],
    pendingApprovals: [],
  };
}
