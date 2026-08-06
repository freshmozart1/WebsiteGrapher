import type {
    ActionEdge,
    ComponentNode,
    FieldNode,
    Goal,
    PageNode,
    SiteGraph,
} from './schema.js';

export function pageById(graph: SiteGraph, id: string): PageNode | undefined {
    return graph.pages.find((p) => p.id === id);
}

export function componentById(
    graph: SiteGraph,
    id: string,
): ComponentNode | undefined {
    return graph.components.find((c) => c.id === id);
}

export function fieldById(graph: SiteGraph, id: string): FieldNode | undefined {
    return graph.fields.find((f) => f.id === id);
}

export function goalById(graph: SiteGraph, id: string): Goal | undefined {
    return graph.goals.find((g) => g.id === id);
}

export function fieldsNamed(
    graph: SiteGraph,
    semanticName: string,
): FieldNode[] {
    return graph.fields.filter((f) => f.semanticName === semanticName);
}

/** The page an edge departs from — an edge may hang off a component (a click
 *  target inside a list) rather than the page itself. */
function edgeSourcePage(
    graph: SiteGraph,
    edge: ActionEdge,
): string | undefined {
    if (graph.pages.some((p) => p.id === edge.sourceNode))
        return edge.sourceNode;
    return componentById(graph, edge.sourceNode)?.pageId;
}

export function edgesFromPage(graph: SiteGraph, pageId: string): ActionEdge[] {
    return graph.edges.filter((e) => edgeSourcePage(graph, e) === pageId);
}

/** Every field name this site actually uses, for matching a question against
 *  the site's own vocabulary rather than a fixed list. */
export function fieldNamesInUse(graph: SiteGraph): string[] {
    return [...new Set(graph.fields.map((f) => f.semanticName))].sort();
}
