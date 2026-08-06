import { parseArgs } from 'node:util';
import { applyPatch } from '../../graph/mutate.js';
import {
    domainKey,
    graphExists,
    originOf,
    withGraph,
} from '../../graph/store.js';
import { learnSite, type LearnOutcome } from '../../analyzer/learn.js';
import { EXIT, UsageError } from '../exit.js';

/**
 * `analyze` learns a site for the first time. `resume` continues a run that
 * stopped to ask about probes it would not perform unattended.
 *
 * Both end the same way: a validated patch on disk, and either a clean exit or
 * exit code 3 with a list of things to approve.
 */

export async function analyzeCommand(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            'max-pages': { type: 'string' },
            'max-probes': { type: 'string' },
            'max-seconds': { type: 'string' },
            headed: { type: 'boolean', default: false },
            force: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });

    const target = positionals[0];
    if (!target) throw new UsageError('wgraph analyze <url>');

    const startUrl = normalizeUrl(target);
    const domain = domainKey(startUrl);

    // Learning again would double every node. The whole point is to visit once.
    if (graphExists(domain) && !values.force) {
        console.log(
            `"${domain}" has already been learned. Ask it something with ` +
                `\`wgraph ask ${domain} "..."\`, or pass --force to learn it again.`,
        );
        return EXIT.OK;
    }

    const outcome = await learnSite({
        startUrl,
        headless: !values.headed,
        budgets: budgetsFrom(values),
        ...(values.quiet
            ? {}
            : { log: (line: string) => console.error(`  ${line}`) }),
    });

    return await persist(
        domain,
        startUrl,
        outcome,
        Boolean(values.json),
        values.force,
    );
}

export async function resumeCommand(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            approve: { type: 'string' },
            'approve-all': { type: 'boolean', default: false },
            'max-probes': { type: 'string' },
            'max-pages': { type: 'string' },
            'max-seconds': { type: 'string' },
            headed: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });

    const target = positionals[0];
    if (!target) {
        throw new UsageError(
            'wgraph resume <domain> --approve <id,...> | --approve-all',
        );
    }
    const domain = domainKey(target);

    const { graph } = await withGraph(domain, (g) => g);
    if (graph.pendingApprovals.length === 0) {
        console.log(`Nothing is waiting for approval on "${domain}".`);
        return EXIT.OK;
    }

    const approved = values['approve-all']
        ? graph.pendingApprovals.map((a) => a.id)
        : (values.approve ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);

    if (approved.length === 0) {
        console.log(renderPending(graph.pendingApprovals, domain));
        return EXIT.PENDING_APPROVAL;
    }

    const unknown = approved.filter(
        (id) => !graph.pendingApprovals.some((a) => a.id === id),
    );
    if (unknown.length > 0) {
        throw new UsageError(
            `Not waiting for approval: ${unknown.join(', ')}.\n` +
                `Pending: ${graph.pendingApprovals.map((a) => a.id).join(', ')}`,
        );
    }

    const startUrl = graph.origin;
    const outcome = await learnSite({
        startUrl,
        headless: !values.headed,
        budgets: budgetsFrom(values),
        approved,
        ...(values.quiet
            ? {}
            : { log: (line: string) => console.error(`  ${line}`) }),
    });

    // The approved probes have been answered either way; they leave the queue.
    outcome.patch.resolveApprovals = approved;
    return await persist(domain, startUrl, outcome, Boolean(values.json), true);
}

async function persist(
    domain: string,
    startUrl: string,
    outcome: LearnOutcome,
    json: boolean,
    replace: boolean | undefined,
): Promise<number> {
    const { graph } = await withGraph(
        domain,
        (g) => {
            if (replace) {
                // A re-run replaces what was learned rather than layering on top of it.
                g.pages = [];
                g.components = [];
                g.edges = [];
                g.fields = [];
                g.goals = [];
                g.pendingApprovals = [];
                g.entryPageId = '';
            }
            applyPatch(g, outcome.patch);
        },
        { createOrigin: originOf(startUrl) },
    );

    if (json) {
        console.log(
            JSON.stringify(
                { graph, log: outcome.log, spent: outcome.spent },
                null,
                2,
            ),
        );
    } else {
        console.log(summarize(graph, outcome, domain));
    }

    return outcome.pending.length > 0 ? EXIT.PENDING_APPROVAL : EXIT.OK;
}

function summarize(
    graph: {
        pages: unknown[];
        components: unknown[];
        edges: unknown[];
        fields: unknown[];
    },
    outcome: LearnOutcome,
    domain: string,
): string {
    const lines = [
        `Learned ${domain}: ${graph.pages.length} pages, ${graph.components.length} components, ` +
            `${graph.edges.length} actions, ${graph.fields.length} fields.`,
        `Visited ${outcome.spent.pages} pages and ran ${outcome.spent.probes} probes in ` +
            `${(outcome.spent.ms / 1000).toFixed(1)}s.`,
    ];
    if (outcome.stoppedBy) {
        lines.push(
            `Stopped early on the ${outcome.stoppedBy} budget — raise it to learn more.`,
        );
    }
    if (outcome.pending.length > 0) {
        lines.push('', renderPending(outcome.pending, domain));
    } else {
        lines.push(
            '',
            `Ask it something: wgraph ask ${domain} "How do I find the price?"`,
        );
    }
    return lines.join('\n');
}

function renderPending(
    pending: { id: string; description: string; reason: string }[],
    domain: string,
): string {
    const lines = [
        `${pending.length} control(s) were left alone because their effect was not obvious:`,
        '',
    ];
    for (const item of pending) {
        lines.push(`  ${item.id}  ${item.description}`);
        lines.push(`      ${item.reason}`);
    }
    lines.push(
        '',
        `Approve the ones you are happy for it to click:`,
        `  wgraph resume ${domain} --approve ${pending.map((p) => p.id).join(',')}`,
    );
    return lines.join('\n');
}

function budgetsFrom(values: Record<string, unknown>) {
    const budgets: Record<string, number> = {};
    const num = (key: string) => {
        const raw = values[key];
        return typeof raw === 'string' ? Number(raw) : undefined;
    };
    const pages = num('max-pages');
    const probes = num('max-probes');
    const seconds = num('max-seconds');
    if (pages !== undefined && Number.isFinite(pages)) budgets.maxPages = pages;
    if (probes !== undefined && Number.isFinite(probes))
        budgets.maxProbes = probes;
    if (seconds !== undefined && Number.isFinite(seconds))
        budgets.maxMs = seconds * 1000;
    return budgets;
}

function normalizeUrl(input: string): string {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
        ? input
        : `https://${input}`;
    return new URL(withScheme).toString();
}
