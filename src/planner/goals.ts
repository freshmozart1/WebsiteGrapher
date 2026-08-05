import { fieldNamesInUse } from "../graph/query.js";
import type { SiteGraph } from "../graph/schema.js";

/**
 * Turning an English question into a target is the model's job — the agent
 * calls `wgraph plan --field <name>` or `--goal <id>` once it has decided.
 *
 * What follows is the deterministic fallback used by `wgraph ask`, so the CLI
 * is usable on its own. It reports a confidence so a low-confidence guess can
 * be overridden rather than trusted.
 */

export type Confidence = "high" | "medium" | "low";

export interface Interpretation {
  kind: "goal" | "field" | "page" | "none";
  goalId?: string;
  semanticName?: string;
  pageId?: string;
  confidence: Confidence;
  /** Other plausible readings, so the caller can say what it did not pick. */
  alternatives: string[];
  reason: string;
}

const STOPWORDS = new Set([
  "a", "an", "the", "how", "do", "does", "did", "i", "we", "you", "to", "of",
  "on", "in", "at", "for", "is", "are", "can", "what", "where", "which", "and",
  "or", "it", "its", "this", "that", "find", "see", "view", "get", "show",
  "steps", "step", "necessary", "needed", "need", "there", "from", "with",
  "me", "my", "be", "was", "were", "one", "some", "any",
]);

/** Only for the four builtin field names — custom names match on their own
 *  tokens, which is why registering `star-rating` rather than `rating2`
 *  matters. */
const SYNONYMS: Record<string, string[]> = {
  price: ["cost", "pricing", "amount", "charge", "expensive", "cheap"],
  title: ["name", "heading", "headline", "called"],
  description: ["summary", "about", "blurb", "overview", "text"],
  image: ["photo", "picture", "thumbnail", "cover", "pic"],
};

function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") ? token.slice(0, -1) : token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

function overlap(questionTokens: Set<string>, candidateTokens: string[]): number {
  return candidateTokens.filter((t) => questionTokens.has(t)).length;
}

interface Scored {
  kind: "goal" | "field" | "page";
  id: string;
  label: string;
  score: number;
}

/**
 * Scores are fractions of the candidate's own name, not raw counts. A goal
 * named "Find the price of a product" must not outrank the detail page on a
 * question about product details just because both mention "product" — what
 * matters is how much of the candidate the question actually covers.
 */
const GOAL_WEIGHT = 6;
const FIELD_NAME_WEIGHT = 5;
const FIELD_SYNONYM_WEIGHT = 3;
const PAGE_TYPE_WEIGHT = 4;
const PAGE_URL_WEIGHT = 1;

export function interpretQuestion(
  graph: SiteGraph,
  question: string,
): Interpretation {
  const tokens = new Set(tokenize(question));
  if (tokens.size === 0) {
    return {
      kind: "none",
      confidence: "low",
      alternatives: [],
      reason: "the question carried no matchable words",
    };
  }

  const scored: Scored[] = [];

  // Goals are named by the agent, so their names are the strongest signal —
  // but only when the question covers most of the name.
  for (const goal of graph.goals) {
    const goalTokens = tokenize(goal.name);
    if (goalTokens.length === 0) continue;
    const score = (overlap(tokens, goalTokens) / goalTokens.length) * GOAL_WEIGHT;
    if (score > 0) {
      scored.push({ kind: "goal", id: goal.id, label: goal.name, score });
    }
  }

  for (const name of fieldNamesInUse(graph)) {
    const nameTokens = name.split("-").map(stem);
    const own =
      (overlap(tokens, nameTokens) / nameTokens.length) * FIELD_NAME_WEIGHT;
    // Any synonym hit counts the same: a long synonym list must not dilute.
    const syn =
      overlap(tokens, (SYNONYMS[name] ?? []).map(stem)) > 0
        ? FIELD_SYNONYM_WEIGHT
        : 0;
    if (own + syn > 0) {
      scored.push({ kind: "field", id: name, label: name, score: own + syn });
    }
  }

  for (const page of graph.pages) {
    const typeTokens = page.type.split("-").map(stem);
    const typeMatch =
      (overlap(tokens, typeTokens) / typeTokens.length) * PAGE_TYPE_WEIGHT;
    const urlMatch =
      overlap(tokens, tokenize(page.urlPattern)) > 0 ? PAGE_URL_WEIGHT : 0;
    if (typeMatch + urlMatch > 0) {
      scored.push({
        kind: "page",
        id: page.id,
        label: `${page.type} page`,
        score: typeMatch + urlMatch,
      });
    }
  }

  if (scored.length === 0) {
    return {
      kind: "none",
      confidence: "low",
      alternatives: [],
      reason: `nothing in the graph matched "${question}"`,
    };
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const best = scored[0];
  if (!best) {
    return {
      kind: "none",
      confidence: "low",
      alternatives: [],
      reason: "no candidates",
    };
  }
  const runnerUp = scored[1];

  // A field beats a same-scoring page: "the price of a product" is a question
  // about a value, and the page it lives on falls out of the plan anyway.
  const tiedField = scored.find(
    (s) => s.kind === "field" && s.score === best.score,
  );
  const chosen = best.kind === "page" && tiedField ? tiedField : best;

  const confidence: Confidence =
    chosen.score >= 4 && (!runnerUp || chosen.score > runnerUp.score)
      ? "high"
      : chosen.score >= 3
        ? "medium"
        : "low";

  return {
    kind: chosen.kind,
    ...(chosen.kind === "goal" ? { goalId: chosen.id } : {}),
    ...(chosen.kind === "field" ? { semanticName: chosen.id } : {}),
    ...(chosen.kind === "page" ? { pageId: chosen.id } : {}),
    confidence,
    alternatives: scored
      .filter((s) => s !== chosen)
      .slice(0, 3)
      .map((s) => s.label),
    reason: `matched ${chosen.kind} "${chosen.label}"`,
  };
}
