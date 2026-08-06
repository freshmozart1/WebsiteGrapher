import { describeLocator } from '../graph/query.js';
import type { SiteGraph } from '../graph/schema.js';
import { vocabularyReport } from '../graph/mutate.js';
import type { Plan } from '../planner/plan.js';

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

export function renderGraph(graph: SiteGraph): string {
    const lines: string[] = [
        `${graph.origin}  (learned ${graph.learnedAt.slice(0, 10)}, schema v${graph.schemaVersion})`,
        '',
        `Pages (${graph.pages.length}):`,
    ];

    for (const page of graph.pages) {
        const entry = page.id === graph.entryPageId ? '  <- entry' : '';
        lines.push(`  ${page.id}  [${page.type}]  ${page.urlPattern}${entry}`);
        for (const c of graph.components.filter((c) => c.pageId === page.id)) {
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
        for (const f of graph.fields.filter((f) => f.pageId === page.id)) {
            const mark = f.verified ? '' : '  (unverified)';
            lines.push(
                `      field ${f.semanticName}  ${describeLocator(f.locator)}${mark}`,
            );
        }
        for (const d of page.stateDimensions ?? []) {
            lines.push(
                `      state ${d.kind}  ${d.label ?? d.componentId}  (${d.valueSource})`,
            );
        }
    }

    lines.push('', `Actions (${graph.edges.length}):`);
    for (const e of graph.edges) {
        lines.push(
            `  ${e.sourceNode} --${e.action}--> ${e.targetNode}   ${describeLocator(e.locator)}`,
        );
    }

    if (graph.goals.length > 0) {
        lines.push('', `Goals (${graph.goals.length}):`);
        for (const g of graph.goals) lines.push(`  ${g.id}  ${g.name}`);
    }

    if (graph.pendingApprovals.length > 0) {
        lines.push(
            '',
            `Awaiting your approval (${graph.pendingApprovals.length}):`,
        );
        for (const a of graph.pendingApprovals) {
            lines.push(`  ${a.id}  ${a.description}`);
            lines.push(`      ${a.reason}`);
        }
        lines.push(
            '',
            `Approve with: wgraph resume ${hostOf(graph.origin)} --approve <id,...>`,
        );
    }

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
