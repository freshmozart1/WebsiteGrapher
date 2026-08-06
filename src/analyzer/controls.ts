import type { Page } from 'playwright';
import type { LocatorDefinition } from '../graph/schema.js';
import { synthesizeLocator } from '../locator/synthesize.js';
import type { NormalizedElement } from './elements.js';
import { probeElement, probeInfiniteScroll } from './probe.js';

/**
 * Phase 5: how does this list reveal more items?
 *
 * Page-number links can be read straight off the hrefs. "Load more" and
 * infinite scroll cannot — they are indistinguishable from an ordinary button
 * and an ordinary long page until you try them, so those two are confirmed by
 * an actual probe.
 */

export type PaginationMode =
    'numbered' | 'next' | 'load-more' | 'infinite-scroll';

export interface PaginationFinding {
    mode: PaginationMode;
    locator: LocatorDefinition | null;
    evidence: string;
}

const PAGE_PARAMS = ['page', 'p', 'offset', 'start', 'from', 'skip', 'pagenum'];
const NEXT_WORDS = ['next', 'older', 'forward', '»', '›', '>>'];
const MORE_WORDS = [
    'load more',
    'show more',
    'more results',
    'see more',
    'load additional',
];

/**
 * Two numbered links, or one plus a next control: on a two-page pager the
 * current page is rendered as plain text, so only one number is ever a link.
 */
async function detectNumberedPagination(
    page: Page,
    visible: NormalizedElement[],
): Promise<PaginationFinding | null> {
    const numbered = numberedLinks(visible);
    const next = visible.find((e) => isNext(e));

    if (!(numbered.length >= 2 || (numbered.length === 1 && next))) {
        return null;
    }

    const locator = next
        ? await synthesizeLocator(page, next)
        : await synthesizeLocator(page, numbered[0]!);
    return {
        mode: 'numbered',
        locator,
        evidence:
            numbered.length >= 2
                ? `${numbered.length} page-number links differing by a paging parameter`
                : 'a page-number link alongside a next control',
    };
}

async function detectNextPagination(
    page: Page,
    visible: NormalizedElement[],
    containerCss: string | null,
): Promise<PaginationFinding | null> {
    const next = visible.find((e) => isNext(e));
    if (!next) return null;

    const locator = await synthesizeLocator(page, next);
    if (!locator) return null;

    if (!containerCss) {
        return { mode: 'next', locator, evidence: 'labelled as a next-page control' };
    }

    const result = await probeElement(page, next, locator, { containerCss });
    if (
        result.change.kind === 'pagination' ||
        result.change.kind === 'navigation'
    ) {
        return {
            mode: 'next',
            locator,
            evidence: `clicking it ${result.change.detail}`,
        };
    }
    return null;
}

async function detectLoadMorePagination(
    page: Page,
    visible: NormalizedElement[],
    containerCss: string | null,
): Promise<PaginationFinding | null> {
    const more = visible.find((e) => isLoadMore(e));
    if (!more || !containerCss) return null;

    const locator = await synthesizeLocator(page, more);
    if (!locator) return null;

    const result = await probeElement(page, more, locator, { containerCss });
    if (!result.change.appended) return null;

    return {
        mode: 'load-more',
        locator,
        evidence: `clicking it appended ${
            result.change.itemCountAfter - result.change.itemCountBefore
        } items below the existing ones`,
    };
}

async function detectInfiniteScrollPagination(
    page: Page,
    containerCss: string | null,
): Promise<PaginationFinding | null> {
    if (!containerCss) return null;

    const scrolled = await probeInfiniteScroll(page, containerCss);
    if (!scrolled?.change.appended) return null;

    return {
        mode: 'infinite-scroll',
        locator: null,
        evidence: `scrolling to the bottom appended ${
            scrolled.change.itemCountAfter - scrolled.change.itemCountBefore
        } items`,
    };
}

export async function detectPagination(
    page: Page,
    elements: NormalizedElement[],
    containerCss: string | null,
): Promise<PaginationFinding | null> {
    const visible = elements.filter((e) => e.visible);

    return (
        (await detectNumberedPagination(page, visible)) ??
        (await detectNextPagination(page, visible, containerCss)) ??
        (await detectLoadMorePagination(page, visible, containerCss)) ??
        (await detectInfiniteScrollPagination(page, containerCss))
    );
}

function numberedLinks(elements: NormalizedElement[]): NormalizedElement[] {
    const candidates = elements.filter(
        (e) => e.tag === 'a' && e.href && /^\d{1,4}$/.test(e.text.trim()),
    );
    // Only counts if the links actually differ by a paging parameter — otherwise
    // they are just links that happen to be labelled with numbers.
    return candidates.filter((e) => {
        const url = safeUrl(e.href!);
        if (!url) return false;
        return (
            PAGE_PARAMS.some((p) => url.searchParams.has(p)) ||
            /\/\d+\/?$/.test(url.pathname)
        );
    });
}

function isNext(el: NormalizedElement): boolean {
    const label =
        `${el.text} ${el.ariaLabel ?? ''} ${el.classes.join(' ')}`.toLowerCase();
    return NEXT_WORDS.some((w) => label.includes(w)) && !isLoadMore(el);
}

function isLoadMore(el: NormalizedElement): boolean {
    const label =
        `${el.text} ${el.ariaLabel ?? ''} ${el.id ?? ''}`.toLowerCase();
    return (
        MORE_WORDS.some((w) => label.includes(w)) || label.includes('load-more')
    );
}

function safeUrl(input: string): URL | null {
    try {
        return new URL(input);
    } catch {
        return null;
    }
}
