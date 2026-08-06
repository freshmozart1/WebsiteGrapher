import type { Page } from 'playwright';
import type { DomHelpers } from '../browser/dom-helpers.js';

/**
 * Phase 3: find repeating structures.
 *
 * Siblings that share a structural signature — same tag, same class tokens,
 * same child tag sequence — are the candidate list. Ranking is by how much of
 * the page they occupy, so a three-item breadcrumb never outranks a
 * twenty-item product grid.
 *
 * No content is read: signatures are built from tags and classes only.
 */
export interface RepetitionCluster {
    /** CSS selector for the element holding the repeated children. */
    containerCss: string;
    /** Selector for one item, relative to the container. */
    itemCss: string;
    /** Selector for the thing you click inside an item, relative to the item. */
    clickTargetCss: string | null;
    /** Absolute href pattern of the click target, when it is a link. */
    sampleHrefs: string[];
    count: number;
    /** Fraction of the viewport the cluster covers, 0..1. */
    areaShare: number;
    /** Average element children per item. A nav link has none; a product card
     *  has an image, a heading and a price. */
    avgItemChildren: number;
    /** Nearest navigation landmark this cluster sits inside, if any. */
    landmark: string | null;
    /** Excluded clusters are still reported, so the agent can overrule the
     *  heuristic on a site that puts its real list somewhere unusual. */
    excluded: boolean;
    exclusionReason: string | null;
    score: number;
}

const MIN_ITEMS = 3;
const MAX_CLUSTERS = 8;
/**
 * A menu, a breadcrumb and a pager are all repeating structures. What
 * separates them from an item list is where they sit and how much of the page
 * they take up — not how many of them there are.
 */
const MIN_AREA_SHARE = 0.02;
const LANDMARKS = ['nav', 'header', 'footer'];

export async function findRepetition(page: Page): Promise<RepetitionCluster[]> {
    return await page.evaluate(
        ({ minItems, maxClusters, minAreaShare, landmarks }) => {
            const wg: DomHelpers = window.__wgraph;

            /** Tag + classes + child tag sequence. Deliberately ignores text. */
            function signatureOf(el: Element): string {
                const classes = Array.prototype.slice
                    .call(el.classList)
                    .sort()
                    .join('.');
                const children = Array.prototype.map
                    .call(el.children, (c: Element) => c.tagName.toLowerCase())
                    .join(',');
                return `${el.tagName.toLowerCase()}|${classes}|${children}`;
            }

            function areaOf(el: Element): number {
                const box = el.getBoundingClientRect();
                return Math.max(0, box.width) * Math.max(0, box.height);
            }

            const viewportArea = Math.max(
                1,
                window.innerWidth * window.innerHeight,
            );
            const clusters: RepetitionCluster[] = [];
            const containers = Array.prototype.slice.call(
                document.querySelectorAll('*'),
            ) as Element[];

            for (const container of containers) {
                if (container.children.length < minItems) continue;

                const bySignature = new Map<string, Element[]>();
                for (const child of Array.prototype.slice.call(
                    container.children,
                ) as Element[]) {
                    const sig = signatureOf(child);
                    const bucket = bySignature.get(sig);
                    if (bucket) bucket.push(child);
                    else bySignature.set(sig, [child]);
                }

                for (const [, items] of bySignature) {
                    if (items.length < minItems) continue;
                    const first = items[0];
                    if (!first) continue;

                    const totalArea = items.reduce(
                        (sum, el) => sum + areaOf(el),
                        0,
                    );
                    if (totalArea === 0) continue;

                    const classes = Array.prototype.slice.call(
                        first.classList,
                    ) as string[];
                    const itemCss =
                        classes.length > 0
                            ? `${first.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join('.')}`
                            : first.tagName.toLowerCase();

                    const anchor = first.querySelector('a[href]');
                    const hrefs = items
                        .slice(0, 3)
                        .map((item) => item.querySelector('a[href]'))
                        .filter(
                            (a): a is HTMLAnchorElement =>
                                a instanceof HTMLAnchorElement,
                        )
                        .map((a) => a.href);

                    const areaShare = Math.min(1, totalArea / viewportArea);
                    const avgItemChildren =
                        items.reduce((sum, el) => sum + el.children.length, 0) /
                        items.length;
                    // Only the chrome landmarks count here: a list inside <main> is the
                    // page's own content, and excluding it would throw away the answer.
                    const landmark = wg.landmarkOf(container, landmarks);

                    let exclusionReason: string | null = null;
                    if (landmark !== null) {
                        exclusionReason = `sits inside <${landmark}>, so it is navigation rather than a list of items`;
                    } else if (areaShare < minAreaShare) {
                        exclusionReason = `covers only ${(areaShare * 100).toFixed(1)}% of the viewport`;
                    }

                    // Item count, page share, and how much structure each item has. A
                    // breadcrumb has the count but neither the area nor the structure.
                    const richness = Math.min(1, (1 + avgItemChildren) / 3);

                    clusters.push({
                        containerCss: wg.cssPathOf(container),
                        itemCss,
                        clickTargetCss: anchor
                            ? wg.relativePath(first, anchor)
                            : null,
                        sampleHrefs: hrefs,
                        count: items.length,
                        areaShare,
                        avgItemChildren,
                        landmark,
                        excluded: exclusionReason !== null,
                        exclusionReason,
                        score: items.length * areaShare * richness,
                    });
                }
            }

            // Plausible lists first; excluded ones are kept at the end so the agent
            // can see what was rejected and why.
            clusters.sort((a, b) => {
                if (a.excluded !== b.excluded) return a.excluded ? 1 : -1;
                return b.score - a.score;
            });
            return clusters.slice(0, maxClusters);
        },
        {
            minItems: MIN_ITEMS,
            maxClusters: MAX_CLUSTERS,
            minAreaShare: MIN_AREA_SHARE,
            landmarks: LANDMARKS,
        },
    );
}
