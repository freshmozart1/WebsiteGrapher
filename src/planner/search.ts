import { edgesFromPage } from '../graph/query.js';
import type { Action, ActionEdge, SiteGraph } from '../graph/schema.js';

/**
 * Weighted shortest path over ActionEdges.
 *
 * Weights come from the action alone. Nothing here reads a page type, so
 * registering a new page type can never change or break planning.
 */
export const ACTION_COST: Record<Action, number> = {
    navigate: 1, // following a known URL or link — cheapest
    click: 2,
    select: 3,
    scroll: 3,
    fill: 5, // needs input from the user, so prefer any route that avoids it
};

export interface PathStep {
    edge: ActionEdge;
    fromPage: string;
    toPage: string;
}

interface Entry {
    cost: number;
    steps: PathStep[];
}

/** Deterministic ordering: cheaper first, then fewer steps, then edge ids.
 *  Two runs over the same graph must always produce the same plan. */
function better(a: Entry, b: Entry): boolean {
    if (a.cost !== b.cost) return a.cost < b.cost;
    if (a.steps.length !== b.steps.length)
        return a.steps.length < b.steps.length;
    return trail(a) < trail(b);
}

function trail(e: Entry): string {
    return e.steps.map((s) => s.edge.id).join('>');
}

/** The cheapest not-yet-settled entry in `best`, or null once none remain. */
function pickNextUnsettled(
    best: Map<string, Entry>,
    settled: Set<string>,
): { id: string; entry: Entry } | null {
    let currentId: string | undefined;
    let current: Entry | undefined;
    for (const [id, entry] of best) {
        if (settled.has(id)) continue;
        if (!current || better(entry, current)) {
            current = entry;
            currentId = id;
        }
    }
    return currentId && current ? { id: currentId, entry: current } : null;
}

/** Update `best` with every outgoing edge from `currentId` that improves on
 *  the entry already known for its target. */
function relaxEdges(
    graph: SiteGraph,
    currentId: string,
    current: Entry,
    settled: Set<string>,
    best: Map<string, Entry>,
): void {
    const outgoing = [...edgesFromPage(graph, currentId)].sort((a, b) =>
        a.id.localeCompare(b.id),
    );
    for (const edge of outgoing) {
        if (settled.has(edge.targetNode)) continue;
        const candidate: Entry = {
            cost: current.cost + ACTION_COST[edge.action],
            steps: [
                ...current.steps,
                { edge, fromPage: currentId, toPage: edge.targetNode },
            ],
        };
        const existing = best.get(edge.targetNode);
        if (!existing || better(candidate, existing)) {
            best.set(edge.targetNode, candidate);
        }
    }
}

/**
 * @returns the ordered steps from `fromPageId` to `toPageId`, or null if the
 *          graph holds no route. An empty array means they are the same page.
 */
export function findPath(
    graph: SiteGraph,
    fromPageId: string,
    toPageId: string,
): PathStep[] | null {
    if (fromPageId === toPageId) return [];

    const best = new Map<string, Entry>([[fromPageId, { cost: 0, steps: [] }]]);
    const settled = new Set<string>();

    for (;;) {
        const next = pickNextUnsettled(best, settled);
        if (!next) return null;
        if (next.id === toPageId) return next.entry.steps;
        settled.add(next.id);

        relaxEdges(graph, next.id, next.entry, settled, best);
    }
}

/** Pages reachable from the entry point, for reporting gaps in what was learned. */
export function reachablePages(
    graph: SiteGraph,
    fromPageId: string,
): Set<string> {
    const seen = new Set<string>([fromPageId]);
    const queue = [fromPageId];
    while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) break;
        for (const edge of edgesFromPage(graph, id)) {
            if (!seen.has(edge.targetNode)) {
                seen.add(edge.targetNode);
                queue.push(edge.targetNode);
            }
        }
    }
    return seen;
}
