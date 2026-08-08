import { describe, expect, it } from 'vitest';
import { classifyPage } from '../../src/analyzer/classify.js';
import type { PageSignals } from '../../src/analyzer/observe.js';

function signals(overrides: Partial<PageSignals> = {}): PageSignals {
    return {
        path: '/page',
        pathSegments: ['page'],
        looksLikeItemUrl: false,
        hasQuery: false,
        formCount: 0,
        postFormCount: 0,
        inputCount: 0,
        searchInputCount: 0,
        linkCount: 0,
        buttonCount: 0,
        imageCount: 0,
        headings: { h1: 0, h2: 0, h3: 0 },
        topClusterSize: 0,
        topClusterAreaShare: 0,
        topClusterLinks: false,
        paginationHints: [],
        ...overrides,
    };
}

describe('classifyPage', () => {
    it('classifies a visible POST form with enough inputs as form/high', () => {
        const result = classifyPage(
            signals({ postFormCount: 1, formCount: 1, inputCount: 3 }),
            false,
        );
        expect(result.type).toBe('form');
        expect(result.confidence).toBe('high');
    });

    it('does not classify a page whose forms and inputs are all hidden as form, at any confidence', () => {
        // What observePage() now produces for a page like the one in issue #2:
        // six Elementor popup forms, none rendered until a button is clicked,
        // so visibility-aware counting leaves nothing for the form rules to see.
        const result = classifyPage(
            signals({ postFormCount: 0, formCount: 0, inputCount: 0 }),
            false,
        );
        expect(result.type).not.toBe('form');
    });

    it('prefers overview over form when a hidden-forms page has a visible list of items', () => {
        // Mirrors the issue: a page of role cards (the visible content) whose
        // six popup application forms are not rendered on load.
        const result = classifyPage(
            signals({
                postFormCount: 0,
                formCount: 0,
                inputCount: 0,
                headings: { h1: 1, h2: 0, h3: 0 },
                topClusterSize: 6,
                topClusterAreaShare: 0.6,
                topClusterLinks: true,
            }),
            true,
        );
        expect(result.type).toBe('overview');
        expect(result.type).not.toBe('form');
    });
});
