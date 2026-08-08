import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    analyzeCommand,
    resumeCommand,
} from '../../src/cli/commands/analyze.js';
import { graphCommand } from '../../src/cli/commands/graph.js';
import { observeCommand } from '../../src/cli/commands/observe.js';
import { askCommand, planCommand } from '../../src/cli/commands/plan.js';
import { sessionCommand } from '../../src/cli/commands/session.js';
import { EXIT, UsageError } from '../../src/cli/exit.js';
import { saveGraph, sessionsDir } from '../../src/graph/store.js';
import { bookshopGraph } from '../helpers/graphs.js';

let home: string;
let out: string[];

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'wgraph-cli-'));
    process.env.WGRAPH_HOME = home;
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
    });
});

afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.WGRAPH_HOME;
    await rm(home, { recursive: true, force: true });
});

const printed = () => out.join('\n');

describe('wgraph ask', () => {
    beforeEach(async () => {
        await saveGraph('books.toscrape.com', bookshopGraph());
    });

    it('answers the price question from the stored graph', async () => {
        const code = await askCommand([
            'books.toscrape.com',
            'How do I find the price of a product?',
        ]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toContain(
            '1. Click the "Books" link to reach the overview page',
        );
        expect(printed()).toContain(
            '2. Click an item in the list to reach the detail page',
        );
        expect(printed()).toContain('3. The price is on the detail page');
    });

    it('answers the navigation question', async () => {
        const code = await askCommand([
            'books.toscrape.com',
            'What steps are necessary to view the product details?',
        ]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toContain('That is the detail page');
    });

    it('answers a question about a custom field name', async () => {
        await askCommand([
            'books.toscrape.com',
            'Where can I see the star rating?',
        ]);
        expect(printed()).toContain('The star-rating is on the detail page');
    });

    it('accepts a full URL as the domain', async () => {
        const code = await askCommand([
            'https://books.toscrape.com/catalogue/whatever/index.html',
            'where is the price',
        ]);
        expect(code).toBe(EXIT.OK);
    });

    it('reports a gap instead of guessing when nothing matches', async () => {
        const code = await askCommand([
            'books.toscrape.com',
            'What is the delivery lead time?',
        ]);
        expect(code).toBe(EXIT.GAP);
        expect(printed()).toMatch(/Could not tell what/);
    });

    it('emits JSON when asked', async () => {
        await askCommand([
            'books.toscrape.com',
            'where is the price',
            '--json',
        ]);
        const parsed = JSON.parse(printed());
        expect(parsed.ok).toBe(true);
        expect(parsed.field.semanticName).toBe('price');
    });

    it('requires a question', async () => {
        await expect(askCommand(['books.toscrape.com'])).rejects.toThrow(
            UsageError,
        );
    });

    it.each(['-h', '--help'])('prints usage for %s', async (flag) => {
        expect(await askCommand([flag])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph ask <domain>');
    });
});

describe('wgraph plan', () => {
    beforeEach(async () => {
        await saveGraph('books.toscrape.com', bookshopGraph());
    });

    it('routes to an explicitly named field', async () => {
        const code = await planCommand([
            'books.toscrape.com',
            '--field',
            'availability',
        ]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toContain('The availability is on the detail page');
    });

    it('returns a gap code for a field the site does not have', async () => {
        expect(
            await planCommand([
                'books.toscrape.com',
                '--field',
                'shipping-weight',
            ]),
        ).toBe(EXIT.GAP);
    });

    it('insists on exactly one target', async () => {
        await expect(planCommand(['books.toscrape.com'])).rejects.toThrow(
            UsageError,
        );
        await expect(
            planCommand([
                'books.toscrape.com',
                '--field',
                'price',
                '--page',
                'page-home',
            ]),
        ).rejects.toThrow(UsageError);
    });

    it.each(['-h', '--help'])('prints usage for %s', async (flag) => {
        expect(await planCommand([flag])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph plan <domain>');
    });
});

describe('wgraph analyze', () => {
    it.each(['-h', '--help'])('prints usage for %s', async (flag) => {
        expect(await analyzeCommand([flag])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph analyze <url>');
    });
});

describe('wgraph resume', () => {
    it.each(['-h', '--help'])('prints usage for %s', async (flag) => {
        expect(await resumeCommand([flag])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph resume <domain>');
    });
});

describe('wgraph observe', () => {
    it.each(['-h', '--help'])('prints usage for %s', async (flag) => {
        expect(await observeCommand([flag])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph observe <url>');
    });
});

describe('wgraph graph', () => {
    it('lists nothing before anything is learned', async () => {
        expect(await graphCommand(['list'])).toBe(EXIT.OK);
        expect(printed()).toMatch(/No sites learned yet/);
    });

    it('applies a patch from a file and validates the result', async () => {
        const patch = join(home, 'patch.json');
        await writeFile(
            patch,
            JSON.stringify({
                pages: [
                    {
                        id: 'page-home',
                        type: 'home',
                        urlPattern: '/',
                        entry: true,
                    },
                    { id: 'page-list', type: 'overview', urlPattern: '/items' },
                ],
                edges: [
                    {
                        sourceNode: 'page-home',
                        targetNode: 'page-list',
                        action: 'click',
                        locator: { role: 'link', name: 'Items' },
                    },
                ],
            }),
            'utf8',
        );

        expect(
            await graphCommand(['apply', 'shop.example', '--file', patch]),
        ).toBe(EXIT.OK);
        expect(await graphCommand(['validate', 'shop.example'])).toBe(EXIT.OK);
        expect(printed()).toContain('2 pages');
    });

    it('registers a custom type and then accepts a node using it', async () => {
        await graphCommand([
            'apply',
            'shop.example',
            '--patch',
            JSON.stringify({
                pages: [
                    {
                        id: 'page-home',
                        type: 'home',
                        urlPattern: '/',
                        entry: true,
                    },
                ],
            }),
        ]);
        expect(
            await graphCommand([
                'add-type',
                'shop.example',
                'page',
                'checkout-step',
                '--description',
                'One step of a multi-step purchase flow',
            ]),
        ).toBe(EXIT.OK);
        expect(printed()).toContain('Registered page type "checkout-step"');

        expect(
            await graphCommand([
                'apply',
                'shop.example',
                '--patch',
                JSON.stringify({
                    pages: [
                        {
                            id: 'page-pay',
                            type: 'checkout-step',
                            urlPattern: '/pay',
                        },
                    ],
                }),
            ]),
        ).toBe(EXIT.OK);
    });

    it('refuses to register a type without a description', async () => {
        await graphCommand([
            'apply',
            'shop.example',
            '--patch',
            JSON.stringify({
                pages: [
                    {
                        id: 'page-home',
                        type: 'home',
                        urlPattern: '/',
                        entry: true,
                    },
                ],
            }),
        ]);
        await expect(
            graphCommand(['add-type', 'shop.example', 'page', 'checkout-step']),
        ).rejects.toThrow(/--description is required/);
    });

    it('shows the vocabulary with usage counts', async () => {
        await saveGraph('books.toscrape.com', bookshopGraph());
        await graphCommand(['show', 'books.toscrape.com', '--vocabulary']);
        expect(printed()).toMatch(/custom\s+star-rating\s+used\s+1x/);
        expect(printed()).toMatch(/builtin\s+price\s+used\s+1x/);
    });

    it('marks the entry page when showing a graph', async () => {
        await saveGraph('books.toscrape.com', bookshopGraph());
        await graphCommand(['show', 'books.toscrape.com']);
        expect(printed()).toMatch(/page-home.*<- entry/);
    });

    it('rejects an unknown subcommand', async () => {
        await expect(graphCommand(['frobnicate'])).rejects.toThrow(UsageError);
    });

    it.each(['-h', '--help'])(
        'prints subcommand listing for %s',
        async (flag) => {
            expect(await graphCommand([flag])).toBe(EXIT.OK);
            expect(printed()).toContain('list');
            expect(printed()).toContain('show');
            expect(printed()).toContain('validate');
            expect(printed()).toContain('apply');
            expect(printed()).toContain('add-type');
            expect(printed()).toContain('set-entry');
        },
    );

    it.each([
        ['list'],
        ['show'],
        ['validate'],
        ['apply'],
        ['add-type'],
        ['set-entry'],
    ])('prints usage for "%s --help" without throwing', async (sub) => {
        expect(await graphCommand([sub, '--help'])).toBe(EXIT.OK);
        expect(printed().length).toBeGreaterThan(0);
    });

    it('reproduces the issue: "graph apply --help" does not throw', async () => {
        expect(await graphCommand(['apply', '--help'])).toBe(EXIT.OK);
        const first = printed();
        expect(first).toContain('pages');
        expect(first).toContain('components');
        expect(first).toContain('fields');
        expect(first).toContain('edges');
    });

    it('reproduces the issue: "graph apply <domain> --help" does not throw', async () => {
        expect(await graphCommand(['apply', 'shop.example', '--help'])).toBe(
            EXIT.OK,
        );
        expect(printed()).toContain('pages');
        expect(printed()).toContain('components');
        expect(printed()).toContain('fields');
        expect(printed()).toContain('edges');
    });
});

describe('wgraph session', () => {
    it('reports no sessions when none are saved', async () => {
        expect(await sessionCommand(['list'])).toBe(EXIT.OK);
        expect(printed()).toMatch(/No saved sessions/);
    });

    it('lists saved sessions with their current url', async () => {
        await mkdir(sessionsDir(), { recursive: true });
        await writeFile(
            join(sessionsDir(), 'books.json'),
            JSON.stringify({
                name: 'books',
                origin: 'https://books.toscrape.com',
                currentUrl: 'https://books.toscrape.com/catalogue',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-02T00:00:00.000Z',
            }),
            'utf8',
        );

        expect(await sessionCommand(['list'])).toBe(EXIT.OK);
        expect(printed()).toContain(
            'books  https://books.toscrape.com/catalogue  (updated 2024-01-02T00:00:00.000Z)',
        );
    });

    it('clears a saved session', async () => {
        await mkdir(sessionsDir(), { recursive: true });
        const statePath = join(sessionsDir(), 'books.json');
        await writeFile(statePath, JSON.stringify({ name: 'books' }), 'utf8');

        expect(await sessionCommand(['clear', 'books'])).toBe(EXIT.OK);
        expect(printed()).toContain('Cleared saved state for "books"');
        expect(existsSync(statePath)).toBe(false);
    });

    it('requires a name to clear', async () => {
        await expect(sessionCommand(['clear'])).rejects.toThrow(UsageError);
    });

    it('rejects an unknown subcommand', async () => {
        await expect(sessionCommand(['frobnicate'])).rejects.toThrow(
            UsageError,
        );
    });

    it.each(['-h', '--help'])(
        'prints subcommand listing for %s',
        async (flag) => {
            expect(await sessionCommand([flag])).toBe(EXIT.OK);
            expect(printed()).toContain('list');
            expect(printed()).toContain('clear');
        },
    );

    it('prints usage for "session clear --help" instead of clearing a session named --help', async () => {
        expect(await sessionCommand(['clear', '--help'])).toBe(EXIT.OK);
        expect(printed()).toContain('wgraph session clear <name>');
        expect(printed()).not.toContain('Cleared saved state for "--help"');
    });

    it.each(['-h', '--help'])(
        'prints usage for "session list %s" instead of listing sessions',
        async (flag) => {
            expect(await sessionCommand(['list', flag])).toBe(EXIT.OK);
            expect(printed()).toContain('wgraph session list');
            expect(printed()).not.toMatch(/No saved sessions/);
        },
    );
});
