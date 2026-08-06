import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Page } from 'playwright';
import { extractElements, type NormalizedElement } from './elements.js';
import { findRepetition, type RepetitionCluster } from './structure.js';
import { tryAccessibilityTree, type AxNode } from './axtree.js';

/**
 * Phase 1 and the signal half of Phase 2.
 *
 * Everything here is mechanical. The observation carries no judgment: it does
 * not decide what kind of page this is, only what can be counted and located.
 * Assigning the page type is the agent's job, and this is what it reads.
 */

export interface PageSignals {
    path: string;
    pathSegments: string[];
    /** The last path segment looks like one item: an id, or a long slug. */
    looksLikeItemUrl: boolean;
    hasQuery: boolean;
    formCount: number;
    postFormCount: number;
    inputCount: number;
    searchInputCount: number;
    linkCount: number;
    buttonCount: number;
    imageCount: number;
    headings: { h1: number; h2: number; h3: number };
    /** Size and page share of the largest repeating cluster. */
    topClusterSize: number;
    topClusterAreaShare: number;
    /** Whether the cluster's items link anywhere. A product grid leads to detail
     *  pages; a specification table repeats just as convincingly and leads
     *  nowhere, which is what tells the two apart. */
    topClusterLinks: boolean;
    /** Controls whose labels look like paging. Confirmed later by probing. */
    paginationHints: string[];
}

export interface PageObservation {
    url: string;
    title: string;
    observedAt: string;
    screenshot: string | null;
    elements: NormalizedElement[];
    clusters: RepetitionCluster[];
    signals: PageSignals;
    /** Present only when the browser offered one. Never relied upon. */
    accessibility: AxNode[] | null;
}

const PAGINATION_WORDS = [
    'next',
    'previous',
    'prev',
    'load more',
    'show more',
    'more results',
    'page',
    'older',
    'newer',
    '»',
    '«',
    '›',
    '‹',
];

export async function observePage(
    page: Page,
    options: { screenshotPath?: string } = {},
): Promise<PageObservation> {
    const [elements, clusters, counts, accessibility] = await Promise.all([
        extractElements(page),
        findRepetition(page),
        countDocument(page),
        tryAccessibilityTree(page),
    ]);

    let screenshot: string | null = null;
    if (options.screenshotPath) {
        await mkdir(dirname(options.screenshotPath), { recursive: true });
        await page.screenshot({
            path: options.screenshotPath,
            fullPage: false,
        });
        screenshot = options.screenshotPath;
    }

    const url = new URL(page.url());
    const segments = url.pathname.split('/').filter(Boolean);
    const top = primaryCluster(clusters);

    return {
        url: page.url(),
        title: await page.title(),
        observedAt: new Date().toISOString(),
        screenshot,
        elements,
        clusters,
        accessibility,
        signals: {
            path: url.pathname,
            pathSegments: segments,
            looksLikeItemUrl: looksLikeItem(segments),
            hasQuery: url.search.length > 0,
            formCount: counts.forms,
            postFormCount: counts.postForms,
            inputCount: elements.filter(
                (e) => e.tag === 'input' || e.tag === 'textarea',
            ).length,
            searchInputCount: elements.filter(
                (e) => e.type === 'search' || e.role === 'searchbox',
            ).length,
            linkCount: elements.filter((e) => e.tag === 'a').length,
            buttonCount: elements.filter((e) => e.role === 'button').length,
            imageCount: counts.images,
            headings: counts.headings,
            topClusterSize: top?.count ?? 0,
            topClusterAreaShare: top?.areaShare ?? 0,
            topClusterLinks:
                top?.clickTargetCss !== null &&
                top?.clickTargetCss !== undefined,
            paginationHints: paginationHints(elements),
        },
    };
}

/** The best candidate for "the list on this page", ignoring the menus and
 *  pagers that repeat for reasons of their own. */
export function primaryCluster(
    clusters: RepetitionCluster[],
): RepetitionCluster | undefined {
    return clusters.find((c) => !c.excluded);
}

function looksLikeItem(segments: string[]): boolean {
    // `/catalogue/a-light-in-the-attic_1000/index.html` names an item; the
    // trailing index file says nothing, so look past it.
    const meaningful = segments.filter(
        (s) => !/^index\.(html?|php|aspx)$/i.test(s) && s.length > 0,
    );
    const last = meaningful.at(-1);
    if (!last) return false;
    const stem = last.replace(/\.(html?|php|aspx)$/i, '');
    if (/^\d+$/.test(stem)) return true;
    // A slug: several words joined by hyphens, or a long opaque token.
    return /-/.test(stem) ? stem.split('-').length >= 2 : stem.length >= 12;
}

function paginationHints(elements: NormalizedElement[]): string[] {
    const hits = new Set<string>();
    for (const el of elements) {
        if (!el.visible) continue;
        const haystack =
            `${el.text} ${el.ariaLabel ?? ''} ${el.classes.join(' ')}`
                .toLowerCase()
                .trim();
        if (!haystack) continue;
        for (const word of PAGINATION_WORDS) {
            if (haystack.includes(word)) {
                hits.add(el.ref);
                break;
            }
        }
        // Bare page numbers inside a nav-ish container.
        if (/^\d{1,3}$/.test(el.text) && el.tag === 'a') hits.add(el.ref);
    }
    return [...hits];
}

async function countDocument(page: Page) {
    return await page.evaluate(() => {
        const forms = Array.prototype.slice.call(
            document.querySelectorAll('form'),
        ) as HTMLFormElement[];
        return {
            forms: forms.length,
            postForms: forms.filter(
                (f) =>
                    (f.getAttribute('method') ?? 'get').toLowerCase() ===
                    'post',
            ).length,
            images: document.querySelectorAll('img, picture, svg').length,
            headings: {
                h1: document.querySelectorAll('h1').length,
                h2: document.querySelectorAll('h2').length,
                h3: document.querySelectorAll('h3').length,
            },
        };
    });
}
