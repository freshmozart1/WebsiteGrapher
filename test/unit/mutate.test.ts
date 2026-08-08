import { describe, expect, it } from 'vitest';
import {
    GraphPatchSchema,
    VocabularyError,
    applyPatch,
    isRegistered,
    registerVocab,
    resolveVocabKind,
    unregisterVocab,
    usageCount,
    vocabularyReport,
} from '../../src/graph/mutate.js';
import { emptyGraph } from '../../src/graph/schema.js';
import { parseGraph } from '../../src/graph/store.js';
import { bookshopGraph } from '../helpers/graphs.js';

describe('resolveVocabKind', () => {
    it('accepts the short aliases the CLI exposes', () => {
        expect(resolveVocabKind('page')).toBe('pageTypes');
        expect(resolveVocabKind('component')).toBe('componentTypes');
        expect(resolveVocabKind('field')).toBe('fieldNames');
    });

    it('rejects anything else', () => {
        expect(() => resolveVocabKind('widget')).toThrow(VocabularyError);
    });
});

describe('registerVocab', () => {
    it('adds an unknown value once', () => {
        const g = emptyGraph('https://example.com');
        expect(
            registerVocab(g, 'pageTypes', 'checkout-step', 'One purchase step'),
        ).toEqual({ added: true });
        expect(registerVocab(g, 'pageTypes', 'checkout-step', 'again')).toEqual(
            {
                added: false,
            },
        );
        expect(isRegistered(g, 'pageTypes', 'checkout-step')).toBe(true);
    });

    it('keeps the seeded values alongside custom ones', () => {
        const g = emptyGraph('https://example.com');
        registerVocab(g, 'fieldNames', 'star-rating', 'Stars out of five');
        const names = g.vocabulary.fieldNames.map((e) => e.name);
        expect(names).toContain('price');
        expect(names).toContain('star-rating');
    });

    it('marks custom values so builtins stay distinguishable', () => {
        const g = emptyGraph('https://example.com');
        registerVocab(g, 'fieldNames', 'star-rating', 'Stars out of five');
        expect(
            g.vocabulary.fieldNames.find((e) => e.name === 'star-rating')
                ?.builtin,
        ).toBe(false);
        expect(
            g.vocabulary.fieldNames.find((e) => e.name === 'price')?.builtin,
        ).toBe(true);
    });
});

describe('unregisterVocab', () => {
    it('refuses to remove a builtin, so nothing already written breaks', () => {
        const g = bookshopGraph();
        expect(() => unregisterVocab(g, 'fieldNames', 'price')).toThrow(
            /builtin/,
        );
    });

    it('refuses to remove a value still in use', () => {
        const g = bookshopGraph();
        expect(() => unregisterVocab(g, 'fieldNames', 'star-rating')).toThrow(
            /still used by 1 node/,
        );
    });

    it('removes an unused custom value', () => {
        const g = bookshopGraph();
        registerVocab(g, 'fieldNames', 'isbn', 'International book number');
        unregisterVocab(g, 'fieldNames', 'isbn');
        expect(isRegistered(g, 'fieldNames', 'isbn')).toBe(false);
    });
});

describe('usage reporting', () => {
    it('counts nodes per vocabulary value', () => {
        const g = bookshopGraph();
        expect(usageCount(g, 'fieldNames', 'price')).toBe(1);
        expect(usageCount(g, 'pageTypes', 'home')).toBe(1);
        expect(usageCount(g, 'componentTypes', 'gallery')).toBe(0);
    });

    it('reports every kind with its usage, for `graph show --vocabulary`', () => {
        const report = vocabularyReport(bookshopGraph());
        expect(report.map((r) => r.kind)).toEqual([
            'pageTypes',
            'componentTypes',
            'fieldNames',
        ]);
        const fields = report.find((r) => r.kind === 'fieldNames')!;
        expect(
            fields.entries.find((e) => e.name === 'star-rating'),
        ).toMatchObject({
            inUse: 1,
            builtin: false,
        });
    });
});

describe('applyPatch', () => {
    it('builds a valid graph from nothing', () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(
            g,
            GraphPatchSchema.parse({
                pages: [
                    {
                        id: 'page-home',
                        type: 'home',
                        urlPattern: '/',
                        entry: true,
                    },
                    { id: 'page-list', type: 'overview', urlPattern: '/items' },
                ],
                components: [
                    {
                        id: 'comp-list',
                        pageId: 'page-list',
                        type: 'list',
                        locator: { css: 'ul.items' },
                    },
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
        );
        expect(g.entryPageId).toBe('page-home');
        expect(() => parseGraph(g)).not.toThrow();
    });

    it("keeps a page's component list in step automatically", () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(g, {
            pages: [
                {
                    id: 'page-list',
                    type: 'overview',
                    urlPattern: '/items',
                    entry: true,
                },
            ],
            components: [
                {
                    id: 'comp-list',
                    pageId: 'page-list',
                    type: 'list',
                    locator: { css: 'ul' },
                },
            ],
        });
        expect(g.pages[0]!.components).toEqual(['comp-list']);
    });

    it('generates readable ids when none are given', () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(g, {
            pages: [{ type: 'overview', urlPattern: '/items', entry: true }],
        });
        expect(g.pages[0]!.id).toBe('page-overview');
        applyPatch(g, {
            components: [
                {
                    pageId: 'page-overview',
                    type: 'list',
                    locator: { css: 'ul' },
                },
            ],
        });
        expect(g.components[0]!.id).toBe('comp-list-page-overview');
    });

    it('never reuses an id', () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(g, {
            pages: [
                { type: 'detail', urlPattern: '/a/:id', entry: true },
                { type: 'detail', urlPattern: '/b/:id' },
                { type: 'detail', urlPattern: '/c/:id' },
            ],
        });
        expect(g.pages.map((p) => p.id)).toEqual([
            'page-detail',
            'page-detail-2',
            'page-detail-3',
        ]);
    });

    it('registers vocabulary in the same patch that uses it', () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(g, {
            vocabulary: {
                pageTypes: [
                    { name: 'checkout-step', description: 'One purchase step' },
                ],
            },
            pages: [
                {
                    id: 'page-pay',
                    type: 'checkout-step',
                    urlPattern: '/pay',
                    entry: true,
                },
            ],
        });
        expect(() => parseGraph(g)).not.toThrow();
    });

    it('produces a graph that fails validation when the type was not registered', () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(g, {
            pages: [
                {
                    id: 'page-pay',
                    type: 'checkout-step',
                    urlPattern: '/pay',
                    entry: true,
                },
            ],
        });
        expect(() => parseGraph(g)).toThrow(/not registered/);
    });

    it('queues and resolves probe approvals', () => {
        const g = bookshopGraph();
        const candidate = {
            id: 'probe-1',
            pageId: 'page-overview',
            locator: { role: 'button', name: 'Sort' },
            description: 'button labelled "Sort"',
            risk: 'confirm' as const,
            reason: 'submit-style button with an unrecognised label',
            observedAt: '2026-01-01T00:00:00.000Z',
        };
        applyPatch(g, { pendingApprovals: [candidate] });
        applyPatch(g, { pendingApprovals: [candidate] });
        expect(g.pendingApprovals).toHaveLength(1);

        applyPatch(g, { resolveApprovals: ['probe-1'] });
        expect(g.pendingApprovals).toHaveLength(0);
    });

    it('round-trips the overlay flag onto the stored page', () => {
        const g = emptyGraph('https://shop.example');
        applyPatch(g, {
            pages: [
                {
                    id: 'page-home',
                    type: 'home',
                    urlPattern: '/',
                    entry: true,
                },
                {
                    id: 'page-popup',
                    type: 'form',
                    urlPattern: '/',
                    overlay: true,
                },
            ],
        });
        expect(g.pages.find((p) => p.id === 'page-popup')?.overlay).toBe(
            true,
        );
        expect(() => parseGraph(g)).not.toThrow();
    });

    it('defaults a new field to unverified', () => {
        const g = bookshopGraph();
        applyPatch(g, {
            vocabulary: {
                fieldNames: [{ name: 'isbn', description: 'Book number' }],
            },
            fields: [
                {
                    pageId: 'page-detail',
                    semanticName: 'isbn',
                    locator: { css: '#isbn' },
                },
            ],
        });
        expect(g.fields.at(-1)!.verified).toBe(false);
    });
});
