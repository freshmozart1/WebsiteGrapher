import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    analyzeCommand,
    resumeCommand,
} from '../../src/cli/commands/analyze.js';
import { askCommand, planCommand } from '../../src/cli/commands/plan.js';
import { graphCommand } from '../../src/cli/commands/graph.js';
import { EXIT } from '../../src/cli/exit.js';
import { domainKey, loadGraph } from '../../src/graph/store.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';
import { PRODUCTS } from '../fixtures/site/pages.js';

let site: FixtureSite;
let out: string[];

/**
 * Learning the site takes about seven seconds, so it happens once and every
 * read-only assertion shares the result. Tests that change the graph take a
 * fresh copy via `relearnInFreshHome`.
 */
let sharedHome: string;
let sharedDomain: string;
let sharedCode: number;
let sharedOutput: string;
const temporaryHomes: string[] = [];

beforeAll(async () => {
    site = await startFixtureSite();
    sharedHome = await mkdtemp(join(tmpdir(), 'wgraph-e2e-shared-'));
    process.env.WGRAPH_HOME = sharedHome;

    const captured: string[] = [];
    const spy = vi
        .spyOn(console, 'log')
        .mockImplementation((...args: unknown[]) =>
            captured.push(args.join(' ')),
        );
    sharedCode = await analyzeCommand([
        site.url,
        '--quiet',
        '--max-seconds',
        '90',
    ]);
    spy.mockRestore();

    sharedOutput = captured.join('\n');
    sharedDomain = domainKey(site.url);
}, 180_000);

afterAll(async () => {
    await site.close();
    await rm(sharedHome, { recursive: true, force: true });
    for (const dir of temporaryHomes)
        await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
    process.env.WGRAPH_HOME = sharedHome;
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    process.env.WGRAPH_HOME = sharedHome;
});

const printed = () => out.join('\n');

/** For tests that mutate the graph: a private copy, learned from scratch. */
async function relearnInFreshHome(): Promise<{ code: number; domain: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'wgraph-e2e-'));
    temporaryHomes.push(dir);
    process.env.WGRAPH_HOME = dir;
    const code = await analyzeCommand([
        site.url,
        '--quiet',
        '--max-seconds',
        '90',
    ]);
    return { code, domain: domainKey(site.url) };
}

describe('learning the fixture site end to end', () => {
    it('builds a graph with the three page kinds and the route between them', async () => {
        const graph = await loadGraph(sharedDomain);

        const types = graph.pages.map((p) => p.type);
        expect(types).toContain('home');
        expect(types).toContain('overview');
        expect(types).toContain('detail');

        // entry -> overview -> detail, with the third edge hanging off the
        // list, plus one nav edge for the entry-page link that findOverview
        // visited but rejected (it has no repeating list of its own).
        expect(graph.edges).toHaveLength(3);
        const toDetail = graph.edges.find(
            (e) => e.targetNode === 'page-detail',
        );
        expect(toDetail?.sourceNode).toBe('comp-list');
        expect(toDetail?.action).toBe('click');

        // The regression check for issue #4: a nav candidate that findOverview
        // visited but did not pick as the overview must still be stored as a
        // page, with an edge from the entry page, instead of being silently
        // discarded once the crawl budget paid for the visit.
        const nonOverviewEdges = graph.edges.filter(
            (e) =>
                e.sourceNode === 'page-entry' && e.targetNode !== 'page-overview',
        );
        expect(nonOverviewEdges).toHaveLength(1);
        const navPage = graph.pages.find(
            (p) => p.id === nonOverviewEdges[0]?.targetNode,
        );
        expect(navPage).toBeDefined();
        expect(navPage?.type).toBe('home');
        expect(navPage?.id).not.toBe(graph.entryPageId);
    });

    it('records the list with its item and click-target locators', async () => {
        const graph = await loadGraph(sharedDomain);
        const list = graph.components.find((c) => c.type === 'list');
        expect(list?.locator.css).toContain('ol');
        expect(list?.meta?.itemLocator?.css).toContain('li.product-card');
        expect(list?.meta?.clickTargetLocator?.css).toContain('h3 > a');
    });

    it('keeps only the controls that actually changed the list', async () => {
        const graph = await loadGraph(sharedDomain);

        const filters = graph.components.filter((c) => c.type === 'filter');
        expect(filters.length).toBeGreaterThanOrEqual(2);
        expect(filters.map((f) => f.meta?.controlKind)).toContain('select');

        const overview = graph.pages.find((p) => p.type === 'overview')!;
        const dimensions = overview.stateDimensions ?? [];
        expect(dimensions.some((d) => d.kind === 'filter')).toBe(true);
        expect(dimensions.some((d) => d.kind === 'sort')).toBe(true);
    });

    it('records the pagination mode', async () => {
        const graph = await loadGraph(sharedDomain);
        const pagination = graph.components.find(
            (c) => c.type === 'pagination',
        );
        expect(pagination?.meta?.paginationMode).toBe('numbered');
    });

    it('registers field names the four builtins do not cover', async () => {
        const graph = await loadGraph(sharedDomain);

        const names = graph.fields.map((f) => f.semanticName);
        expect(names).toContain('title');
        expect(names).toContain('price');
        expect(names).toContain('rating');
        expect(names).toContain('availability');

        const custom = graph.vocabulary.fieldNames.filter((e) => !e.builtin);
        expect(custom.map((e) => e.name)).toEqual(
            expect.arrayContaining(['rating', 'availability']),
        );
        for (const entry of custom) {
            expect(entry.description.length).toBeGreaterThan(0);
        }
    });

    it('marks fields verified only when they held on both sampled products', async () => {
        const graph = await loadGraph(sharedDomain);
        const price = graph.fields.find((f) => f.semanticName === 'price');
        expect(price?.verified).toBe(true);
        expect(price?.valueShape).toBe('currency');
    });

    it('stores no page content anywhere in the graph', async () => {
        const serialized = JSON.stringify(await loadGraph(sharedDomain));

        for (const product of PRODUCTS) {
            expect(serialized).not.toContain(product.title);
            expect(serialized).not.toContain(product.price);
            expect(serialized).not.toContain(product.blurb);
        }
        expect(serialized).not.toContain(
            'A small shop that exists only to be analyzed',
        );
    });

    it('passes its own validation', async () => {
        expect(await graphCommand(['validate', sharedDomain])).toBe(EXIT.OK);
    });
});

describe('answering from the stored graph', () => {
    it('answers the price question without opening a browser', async () => {
        const code = await askCommand([
            sharedDomain,
            'How do I find the price of a product?',
        ]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toMatch(/1\. Click/);
        expect(printed()).toMatch(/price is on the detail page/);
    });

    it('answers the navigation question', async () => {
        expect(
            await askCommand([
                sharedDomain,
                'What steps are necessary to view the product details?',
            ]),
        ).toBe(EXIT.OK);
        expect(printed()).toMatch(/detail page/);
    });

    it('answers a question about a field name it had to invent', async () => {
        expect(
            await planCommand([sharedDomain, '--field', 'availability']),
        ).toBe(EXIT.OK);
        expect(printed()).toMatch(/availability is on the detail page/);
    });

    it('reports a gap for something it never learned', async () => {
        expect(
            await planCommand([sharedDomain, '--field', 'shipping-weight']),
        ).toBe(EXIT.GAP);
    });
});

describe('the approval checkpoint', () => {
    it('stops with pending approvals rather than clicking an unrecognised button', async () => {
        expect(sharedCode).toBe(EXIT.PENDING_APPROVAL);

        const graph = await loadGraph(sharedDomain);
        expect(graph.pendingApprovals.length).toBeGreaterThan(0);
        const newsletter = graph.pendingApprovals.find((a) =>
            a.description.includes('Newsletter'),
        );
        expect(newsletter).toBeDefined();
        expect(newsletter!.reason).toMatch(/not obvious/);
    });

    it('tells the user exactly how to approve', () => {
        expect(sharedOutput).toMatch(/wgraph resume .* --approve probe-/);
    });

    it('clears the queue once approved, without adding a no-op as a filter', async () => {
        const { domain } = await relearnInFreshHome();
        const before = await loadGraph(domain);
        const ids = before.pendingApprovals.map((a) => a.id);
        out = [];

        const code = await resumeCommand([
            domain,
            '--approve',
            ids.join(','),
            '--quiet',
        ]);
        expect(code).toBe(EXIT.OK);

        const after = await loadGraph(domain);
        expect(after.pendingApprovals).toHaveLength(0);
        // The newsletter button does nothing, so approving it adds no filter.
        expect(after.components.filter((c) => c.type === 'filter').length).toBe(
            before.components.filter((c) => c.type === 'filter').length,
        );
    }, 180_000);

    it('refuses to resume with an id that is not waiting', async () => {
        await expect(
            resumeCommand([sharedDomain, '--approve', 'probe-nope']),
        ).rejects.toThrow(/Not waiting for approval/);
    });
});

describe('learning twice', () => {
    it('does not re-learn a site it already knows', async () => {
        const code = await analyzeCommand([site.url, '--quiet']);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toMatch(/has already been learned/);

        const graph = await loadGraph(sharedDomain);
        expect(graph.pages.filter((p) => p.type === 'detail')).toHaveLength(1);
    });

    it('replaces rather than duplicates when forced', async () => {
        const { domain } = await relearnInFreshHome();
        const before = await loadGraph(domain);

        await analyzeCommand([site.url, '--quiet', '--force']);
        const after = await loadGraph(domain);

        expect(after.pages).toHaveLength(before.pages.length);
        expect(after.fields).toHaveLength(before.fields.length);
    }, 180_000);
});
