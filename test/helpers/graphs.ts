import {
    SCHEMA_VERSION,
    freshVocabulary,
    type SiteGraph,
    type VocabEntry,
} from '../../src/graph/schema.js';

const NOW = '2026-01-01T00:00:00.000Z';

function custom(name: string, description: string): VocabEntry {
    return { name, description, builtin: false };
}

/**
 * A bookshop shaped like books.toscrape.com: home -> category overview ->
 * product detail, with a filter, a next-page control, and two field names that
 * none of the four builtins cover.
 */
export function bookshopGraph(): SiteGraph {
    const vocabulary = freshVocabulary();
    vocabulary.fieldNames.push(
        custom('star-rating', 'Star rating awarded to the item, one to five'),
        custom('availability', 'Whether the item is in stock, and how many'),
    );

    return {
        schemaVersion: SCHEMA_VERSION,
        origin: 'https://books.toscrape.com',
        learnedAt: NOW,
        entryPageId: 'page-home',
        vocabulary,
        pages: [
            {
                id: 'page-home',
                type: 'home',
                urlPattern: '/',
                components: [],
                learnedAt: NOW,
            },
            {
                id: 'page-overview',
                type: 'overview',
                urlPattern: '/catalogue/category/books/:slug/index.html',
                components: [
                    'comp-list',
                    'comp-filter-category',
                    'comp-pagination',
                ],
                stateDimensions: [
                    {
                        id: 'dim-category',
                        kind: 'filter',
                        componentId: 'comp-filter-category',
                        valueSource: 'options',
                        label: 'Category',
                    },
                    {
                        id: 'dim-page',
                        kind: 'pagination',
                        componentId: 'comp-pagination',
                        valueSource: 'numeric',
                    },
                ],
                learnedAt: NOW,
            },
            {
                id: 'page-detail',
                type: 'detail',
                urlPattern: '/catalogue/:slug/index.html',
                components: [],
                learnedAt: NOW,
            },
        ],
        components: [
            {
                id: 'comp-list',
                pageId: 'page-overview',
                type: 'list',
                locator: { css: 'ol.row' },
                meta: {
                    itemLocator: { css: 'ol.row > li' },
                    clickTargetLocator: { css: 'ol.row > li h3 > a' },
                },
            },
            {
                id: 'comp-filter-category',
                pageId: 'page-overview',
                type: 'filter',
                locator: { role: 'combobox', name: 'Category' },
                meta: { controlKind: 'select' },
            },
            {
                id: 'comp-pagination',
                pageId: 'page-overview',
                type: 'pagination',
                locator: { css: 'ul.pager' },
                meta: { paginationMode: 'next' },
            },
        ],
        edges: [
            {
                id: 'edge-home-to-overview',
                sourceNode: 'page-home',
                targetNode: 'page-overview',
                action: 'click',
                locator: { role: 'link', name: 'Books' },
            },
            {
                id: 'edge-list-to-detail',
                sourceNode: 'comp-list',
                targetNode: 'page-detail',
                action: 'click',
                locator: { css: 'ol.row > li h3 > a' },
            },
        ],
        fields: [
            field('field-title', 'title', { css: '.product_main h1' }),
            field(
                'field-price',
                'price',
                { css: '.product_main .price_color' },
                'currency',
            ),
            field('field-description', 'description', {
                css: '#product_description ~ p',
            }),
            field(
                'field-image',
                'image',
                { css: '#product_gallery img' },
                'url',
            ),
            field('field-star-rating', 'star-rating', {
                css: '.product_main .star-rating',
            }),
            field('field-availability', 'availability', {
                css: '.product_main .availability',
            }),
        ],
        goals: [
            {
                id: 'goal-find-price',
                name: 'Find the price of a product',
                targetField: 'field-price',
                targetPage: 'page-detail',
            },
        ],
        pendingApprovals: [],
    };
}

function field(
    id: string,
    semanticName: string,
    locator: { css: string },
    valueShape?: 'currency' | 'text' | 'url' | 'number',
) {
    return {
        id,
        pageId: 'page-detail',
        semanticName,
        locator,
        verified: true,
        ...(valueShape ? { valueShape } : {}),
    };
}

/**
 * The same shape built entirely from registered custom types. Nothing in the
 * planner may behave differently here — that is the property this fixture
 * exists to prove.
 */
export function customTypeGraph(): SiteGraph {
    const vocabulary = freshVocabulary();
    vocabulary.pageTypes.push(
        custom('landing-panel', 'Operator entry screen for the console'),
        custom('record-grid', 'Dense grid of records with column controls'),
        custom('record-sheet', 'One record shown in full'),
    );
    vocabulary.componentTypes.push(
        custom('record-strip', 'Horizontal strip of record summaries'),
    );
    vocabulary.fieldNames.push(
        custom('identifier', 'Stable record identifier shown to the operator'),
        custom('cost-figure', 'Total cost attached to the record'),
    );

    return {
        schemaVersion: SCHEMA_VERSION,
        origin: 'https://console.example.org',
        learnedAt: NOW,
        entryPageId: 'page-landing',
        vocabulary,
        pages: [
            {
                id: 'page-landing',
                type: 'landing-panel',
                urlPattern: '/',
                components: [],
                learnedAt: NOW,
            },
            {
                id: 'page-grid',
                type: 'record-grid',
                urlPattern: '/records',
                components: ['comp-strip'],
                learnedAt: NOW,
            },
            {
                id: 'page-sheet',
                type: 'record-sheet',
                urlPattern: '/records/:id',
                components: [],
                learnedAt: NOW,
            },
        ],
        components: [
            {
                id: 'comp-strip',
                pageId: 'page-grid',
                type: 'record-strip',
                locator: { css: '[data-strip]' },
                meta: {
                    itemLocator: { css: '[data-strip] [data-record]' },
                    clickTargetLocator: { css: '[data-strip] [data-record] a' },
                },
            },
        ],
        edges: [
            {
                id: 'edge-landing-to-grid',
                sourceNode: 'page-landing',
                targetNode: 'page-grid',
                action: 'click',
                locator: { role: 'link', name: 'Records' },
            },
            {
                id: 'edge-strip-to-sheet',
                sourceNode: 'comp-strip',
                targetNode: 'page-sheet',
                action: 'click',
                locator: { css: '[data-strip] [data-record] a' },
            },
        ],
        fields: [
            {
                id: 'field-identifier',
                pageId: 'page-sheet',
                semanticName: 'identifier',
                locator: { css: '[data-field=id]' },
                verified: true,
            },
            {
                id: 'field-cost',
                pageId: 'page-sheet',
                semanticName: 'cost-figure',
                locator: { css: '[data-field=cost]' },
                verified: true,
                valueShape: 'currency' as const,
            },
        ],
        goals: [],
        pendingApprovals: [],
    };
}
