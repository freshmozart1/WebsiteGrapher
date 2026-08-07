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
 *
 * Two complications, both common in page-builder output (Elementor, Webflow,
 * CSS Modules): first, signatures strip a trailing per-instance hash class
 * (`elementor-element-74a0f97`) before comparing, since otherwise
 * structurally identical siblings never bucket together. Second, a grid is
 * sometimes split across several row containers rather than sitting under one
 * parent, so a second pass looks for sibling rows whose own children resolve
 * to the same item signature and folds them into a single cluster before
 * ranking.
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
/**
 * A single row is just a container with children — it takes at least two
 * rows to show that the *rows themselves* repeat, which is the evidence a
 * split grid needs before its fragments are worth merging.
 */
const MIN_ROWS = 2;
/**
 * Below this length a hex-looking token is more likely a short real word
 * (`nav`, `card`) than a generated hash. Longer per-instance hashes are safe
 * to strip on sight.
 */
const HASH_SUFFIX_MIN_LENGTH = 5;

export async function findRepetition(page: Page): Promise<RepetitionCluster[]> {
    return await page.evaluate(
        ({
            minItems,
            maxClusters,
            minAreaShare,
            landmarks,
            minRows,
            hashSuffixMinLength,
        }) => {
            const wg: DomHelpers = window.__wgraph;

            // Page builders append a unique per-instance hash to every class
            // (`elementor-element-74a0f97`), so a class token is only treated as a
            // hash suffix if every character is hex AND at least one is a digit.
            // That second condition is what makes this safe: an English word like
            // `face`, `cafe`, `dead` or `facade` is made entirely of hex letters
            // but has no digits, so it always fails this test and is never
            // mistaken for a generated hash.
            const HEX_WITH_DIGIT = /^[0-9a-f]*[0-9][0-9a-f]*$/i;

            /**
             * Strips a trailing per-instance hash segment from a class token, so
             * `elementor-element-74a0f97` and `elementor-element-1249c5d` both
             * normalize to `elementor-element` and bucket together. A token with
             * no hyphen, or whose last segment doesn't look like a hash, is
             * returned unchanged. A token that *is* the hash (no prefix left
             * after stripping) carries no structural signal, so it is dropped.
             */
            function normalizeClassToken(token: string): string | null {
                const lastHyphen = token.lastIndexOf('-');
                if (lastHyphen === -1) return token;
                const suffix = token.slice(lastHyphen + 1);
                if (
                    suffix.length >= hashSuffixMinLength &&
                    HEX_WITH_DIGIT.test(suffix)
                ) {
                    const prefix = token.slice(0, lastHyphen);
                    return prefix.length > 0 ? prefix : null;
                }
                return token;
            }

            /** Tag + classes + child tag sequence. Deliberately ignores text. */
            function signatureOf(el: Element): string {
                const classes = Array.from(
                    new Set(
                        (
                            Array.prototype.slice.call(
                                el.classList,
                            ) as string[]
                        )
                            .map(normalizeClassToken)
                            .filter((c): c is string => c !== null),
                    ),
                )
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

            /** Direct children of `container`, bucketed by structural signature. */
            function groupBySignature(
                container: Element,
            ): Map<string, Element[]> {
                const bySignature = new Map<string, Element[]>();
                for (const child of Array.prototype.slice.call(
                    container.children,
                ) as Element[]) {
                    const sig = signatureOf(child);
                    const bucket = bySignature.get(sig);
                    if (bucket) bucket.push(child);
                    else bySignature.set(sig, [child]);
                }
                return bySignature;
            }

            /** Why a cluster is excluded from the plausible-list ranking, if at all. */
            function exclusionReasonFor(
                container: Element,
                areaShare: number,
                landmark: string | null,
            ): string | null {
                if (landmark !== null) {
                    return `sits inside <${landmark}>, so it is navigation rather than a list of items`;
                }
                if (areaShare < minAreaShare) {
                    return `covers only ${(areaShare * 100).toFixed(1)}% of the viewport`;
                }
                return null;
            }

            /** One same-signature sibling group, or null if it can't form a cluster. */
            function buildCluster(
                container: Element,
                items: Element[],
            ): RepetitionCluster | null {
                const first = items[0];
                if (!first) return null;

                const totalArea = items.reduce(
                    (sum, el) => sum + areaOf(el),
                    0,
                );
                if (totalArea === 0) return null;

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
                const exclusionReason = exclusionReasonFor(
                    container,
                    areaShare,
                    landmark,
                );

                // Item count, page share, and how much structure each item has. A
                // breadcrumb has the count but neither the area nor the structure.
                const richness = Math.min(1, (1 + avgItemChildren) / 3);

                return {
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
                };
            }

            /** `container`'s direct children, grouped by signature, biggest bucket
             *  first — or null if there are no children to group at all. */
            function largestBucket(container: Element): Element[] | null {
                if (container.children.length === 0) return null;
                let best: Element[] | null = null;
                for (const [, items] of groupBySignature(container)) {
                    if (!best || items.length > best.length) best = items;
                }
                return best;
            }

            /** Whether `row` itself looks like it holds a repeating list, and if
             *  so, the signature that list's items share. A row that fails this
             *  is not evidence of a split grid — it's just some other element. */
            function rowItemSignature(
                row: Element,
            ): { sig: string; items: Element[] } | null {
                const bucket = largestBucket(row);
                if (!bucket || bucket.length < minItems) return null;
                const first = bucket[0];
                if (!first) return null;
                return { sig: signatureOf(first), items: bucket };
            }

            /**
             * A grid is sometimes split across several row wrappers instead of
             * sitting under one parent (Elementor's column layout does this).
             * For every candidate `wrapper`, group its direct children — the
             * candidate rows — by signature. A bucket of rows only merges when
             * *every* row in it independently looks like a repeating list, and
             * all of those lists share one item signature; a wrapper with one
             * real row of cards next to an unrelated same-shaped row of, say,
             * testimonials should not be forced together.
             */
            function findMergedClusters(
                allContainers: Element[],
            ): { cluster: RepetitionCluster; subsumedRows: Element[] }[] {
                const merges: {
                    cluster: RepetitionCluster;
                    subsumedRows: Element[];
                }[] = [];

                for (const wrapper of allContainers) {
                    if (wrapper.children.length < minRows) continue;

                    for (const [, candidateRows] of groupBySignature(
                        wrapper,
                    )) {
                        if (candidateRows.length < minRows) continue;

                        const resolved = candidateRows.map(rowItemSignature);
                        if (resolved.some((r) => r === null)) continue;
                        const rows = resolved as {
                            sig: string;
                            items: Element[];
                        }[];

                        const firstRow = rows[0];
                        if (!firstRow) continue;
                        if (rows.some((r) => r.sig !== firstRow.sig)) {
                            continue;
                        }

                        const flattenedItems = rows.flatMap((r) => r.items);
                        if (flattenedItems.length < minItems) continue;

                        const cluster = buildCluster(wrapper, flattenedItems);
                        if (cluster) {
                            merges.push({
                                cluster,
                                subsumedRows: candidateRows,
                            });
                        }
                    }
                }

                return merges;
            }

            const clusters: RepetitionCluster[] = [];
            const containers = Array.prototype.slice.call(
                document.querySelectorAll('*'),
            ) as Element[];

            const merges = findMergedClusters(containers);
            const subsumedRows = new Set<Element>();
            for (const merge of merges) {
                for (const row of merge.subsumedRows) subsumedRows.add(row);
            }

            for (const container of containers) {
                // Its children were already folded into a merged cluster one
                // level up; its own fragment would just re-describe a subset.
                if (subsumedRows.has(container)) continue;
                if (container.children.length < minItems) continue;

                for (const [, items] of groupBySignature(container)) {
                    if (items.length < minItems) continue;
                    // The "read these rows themselves as the repeated items"
                    // reading of the same wrapper the merge above already covers.
                    if (items.every((item) => subsumedRows.has(item))) {
                        continue;
                    }
                    const cluster = buildCluster(container, items);
                    if (cluster) clusters.push(cluster);
                }
            }

            for (const merge of merges) {
                clusters.push(merge.cluster);
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
            minRows: MIN_ROWS,
            hashSuffixMinLength: HASH_SUFFIX_MIN_LENGTH,
        },
    );
}
