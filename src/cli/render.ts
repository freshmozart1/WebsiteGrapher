import { describeLocator } from '../graph/describe.js';
import type { PageNode, SiteGraph } from '../graph/schema.js';
import { vocabularyReport } from '../graph/mutate.js';
import type { Plan } from '../planner/plan.js';
import type { PageObservation } from '../analyzer/observe.js';
import type { RepetitionCluster } from '../analyzer/structure.js';
import type { Classification } from '../analyzer/classify.js';
import type { NormalizedElement } from '../analyzer/elements.js';
import type { FieldCandidate } from '../analyzer/fields.js';

/** Everything the CLI prints for humans lives here, so the commands stay
 *  concerned only with what they do. */

export function renderPlan(plan: Plan): string {
    if (!plan.ok) {
        const lines = [plan.reason];
        if (plan.detail.length > 0) {
            lines.push('', ...plan.detail.map((d) => `  ${d}`));
        }
        lines.push('', plan.suggestion);
        return lines.join('\n');
    }

    const lines: string[] = [];
    if (plan.question) lines.push(plan.question, '');

    if (plan.steps.length === 0) {
        lines.push('1. You are already there — no navigation needed.');
    } else {
        plan.steps.forEach((s) => lines.push(`${s.index}. ${s.description}`));
    }

    if (plan.field) {
        lines.push(
            `${plan.steps.length + 1}. The ${plan.field.semanticName} is on the ` +
                `${plan.destination.pageType} page at ${describeLocator(plan.field.locator)}.`,
        );
    } else if (plan.destination.overlay) {
        lines.push(
            `${plan.steps.length + 1}. That opens the ${plan.destination.pageType} overlay.`,
        );
    } else {
        lines.push(
            `${plan.steps.length + 1}. That is the ${plan.destination.pageType} page ` +
                `(${plan.destination.urlPattern}).`,
        );
    }

    if (plan.confidence !== 'high') {
        lines.push('', `Confidence: ${plan.confidence}.`);
    }
    if (plan.notes.length > 0) {
        lines.push('', ...plan.notes.map((n) => `Note: ${n}`));
    }
    return lines.join('\n');
}

/** What `wgraph observe` prints for a human: the full text report built from
 *  one page's observation, draft classification, and risk tiers. */
export function renderObservation(result: {
    observation: PageObservation;
    cluster: RepetitionCluster | undefined;
    draft: Classification;
    tiers: {
        safe: NormalizedElement[];
        confirm: NormalizedElement[];
        blocked: NormalizedElement[];
    };
    fields: FieldCandidate[] | null;
}): string {
    const { observation, cluster, draft, tiers, fields } = result;
    const lines = [
        `${observation.url}`,
        `"${observation.title}"`,
        '',
        `Draft page type: ${draft.type} (${draft.confidence}) — ${draft.reasons.join('; ')}`,
        `  This is a guess from counted signals. Overrule it if the page does not fit.`,
        '',
        `Elements: ${observation.elements.length}  ` +
            `(${tiers.safe.length} safe to probe, ${tiers.confirm.length} need approval, ` +
            `${tiers.blocked.length} off limits)`,
        `Accessibility tree: ${observation.accessibility ? `${observation.accessibility.length} nodes` : 'unavailable'}`,
    ];

    if (cluster) {
        lines.push(
            '',
            `List: ${cluster.count} x ${cluster.itemCss} in ${cluster.containerCss}`,
            `  click target: ${cluster.clickTargetCss ?? 'none'}`,
        );
    } else {
        lines.push('', 'List: none found');
    }

    const rejected = observation.clusters.filter((c) => c.excluded);
    if (rejected.length > 0) {
        lines.push('', 'Rejected repeating structures:');
        for (const c of rejected) {
            lines.push(`  ${c.count} x ${c.itemCss} — ${c.exclusionReason}`);
        }
    }

    if (fields) {
        lines.push('', 'Field candidates:');
        for (const f of fields) {
            lines.push(
                `  ${f.suggestedName.padEnd(14)} ${f.css}  (${f.confidence}: ${f.reason})`,
            );
        }
    }

    if (observation.screenshot)
        lines.push('', `Screenshot: ${observation.screenshot}`);

    return lines.join('\n');
}

function renderComponentLines(graph: SiteGraph, pageId: string): string[] {
    const lines: string[] = [];
    for (const c of graph.components.filter((c) => c.pageId === pageId)) {
        const extra = [
            c.meta?.paginationMode ? `mode=${c.meta.paginationMode}` : '',
            c.meta?.controlKind ? `control=${c.meta.controlKind}` : '',
        ]
            .filter(Boolean)
            .join(' ');
        lines.push(
            `      component ${c.id}  [${c.type}]  ${describeLocator(c.locator)}${extra ? `  ${extra}` : ''}`,
        );
    }
    return lines;
}

function renderFieldLines(graph: SiteGraph, pageId: string): string[] {
    const lines: string[] = [];
    for (const f of graph.fields.filter((f) => f.pageId === pageId)) {
        const mark = f.verified ? '' : '  (unverified)';
        lines.push(
            `      field ${f.semanticName}  ${describeLocator(f.locator)}${mark}`,
        );
    }
    return lines;
}

function renderStateDimensionLines(page: PageNode): string[] {
    return (page.stateDimensions ?? []).map(
        (d) => `      state ${d.kind}  ${d.label ?? d.componentId}  (${d.valueSource})`,
    );
}

/** One page's heading plus its components, fields, and state dimensions. */
function renderPageSection(graph: SiteGraph, page: PageNode): string[] {
    const entry = page.id === graph.entryPageId ? '  <- entry' : '';
    return [
        `  ${page.id}  [${page.type}]  ${page.urlPattern}${page.overlay ? '  (overlay)' : ''}${entry}`,
        ...renderComponentLines(graph, page.id),
        ...renderFieldLines(graph, page.id),
        ...renderStateDimensionLines(page),
    ];
}

function renderActionsSection(graph: SiteGraph): string[] {
    const lines = ['', `Actions (${graph.edges.length}):`];
    for (const e of graph.edges) {
        lines.push(
            `  ${e.sourceNode} --${e.action}--> ${e.targetNode}   ${describeLocator(e.locator)}`,
        );
    }
    return lines;
}

function renderGoalsSection(graph: SiteGraph): string[] {
    if (graph.goals.length === 0) return [];
    const lines = ['', `Goals (${graph.goals.length}):`];
    for (const g of graph.goals) lines.push(`  ${g.id}  ${g.name}`);
    return lines;
}

function renderApprovalsSection(graph: SiteGraph): string[] {
    if (graph.pendingApprovals.length === 0) return [];
    const lines = [
        '',
        `Awaiting your approval (${graph.pendingApprovals.length}):`,
    ];
    for (const a of graph.pendingApprovals) {
        lines.push(`  ${a.id}  ${a.description}`);
        lines.push(`      ${a.reason}`);
    }
    lines.push(
        '',
        `Approve with: wgraph resume ${hostOf(graph.origin)} --approve <id,...>`,
    );
    return lines;
}

export function renderGraph(graph: SiteGraph): string {
    const lines: string[] = [
        `${graph.origin}  (learned ${graph.learnedAt.slice(0, 10)}, schema v${graph.schemaVersion})`,
        '',
        `Pages (${graph.pages.length}):`,
    ];

    for (const page of graph.pages) {
        lines.push(...renderPageSection(graph, page));
    }

    lines.push(...renderActionsSection(graph));
    lines.push(...renderGoalsSection(graph));
    lines.push(...renderApprovalsSection(graph));

    return lines.join('\n');
}

export function renderVocabulary(graph: SiteGraph): string {
    const titles: Record<string, string> = {
        pageTypes: 'Page types',
        componentTypes: 'Component types',
        fieldNames: 'Field names',
    };
    const lines: string[] = [];
    for (const { kind, entries } of vocabularyReport(graph)) {
        lines.push(`${titles[kind] ?? kind}:`);
        for (const e of entries) {
            const origin = e.builtin ? 'builtin' : 'custom ';
            lines.push(
                `  ${origin}  ${e.name.padEnd(16)} used ${String(e.inUse).padStart(2)}x   ${e.description}`,
            );
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

function hostOf(origin: string): string {
    try {
        return new URL(origin).hostname.replace(/^www\./, '');
    } catch {
        return origin;
    }
}
