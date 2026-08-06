import type { ListFingerprint, PageFingerprint } from './fingerprint.js';

/**
 * What an interaction actually did.
 *
 * Only `list-changed` earns an element the label "filter". Everything else is
 * either navigation, paging, cosmetic, or nothing at all — and saying which is
 * what stops a menu toggle being recorded as a filter.
 */
export type ChangeKind =
    'noop' | 'list-changed' | 'pagination' | 'navigation' | 'layout-only';

export interface ChangeClassification {
    kind: ChangeKind;
    /** One line explaining the call, carried into the graph's reasoning trail. */
    detail: string;
    urlChanged: boolean;
    itemCountBefore: number;
    itemCountAfter: number;
    /** Same items, different order — a sort rather than a filter. */
    reordered: boolean;
    /** Items were added to the end while the existing ones stayed put. */
    appended: boolean;
}

/** Query parameters that mean "which page of results". */
const PAGE_PARAMS = ['page', 'p', 'offset', 'start', 'from', 'skip', 'pagenum'];

export function classifyChange(
    before: PageFingerprint,
    after: PageFingerprint,
): ChangeClassification {
    const beforeUrl = safeUrl(before.url);
    const afterUrl = safeUrl(after.url);
    const urlChanged = before.url !== after.url;
    const pathChanged = beforeUrl?.pathname !== afterUrl?.pathname;

    const b = before.list;
    const a = after.list;
    const countBefore = b?.itemCount ?? 0;
    const countAfter = a?.itemCount ?? 0;

    const base = {
        urlChanged,
        itemCountBefore: countBefore,
        itemCountAfter: countAfter,
        reordered: false,
        appended: false,
    };

    // Leaving the page is navigation regardless of what happened to the list.
    if (pathChanged) {
        return {
            ...base,
            kind: 'navigation',
            detail: `moved from ${beforeUrl?.pathname ?? '?'} to ${afterUrl?.pathname ?? '?'}`,
        };
    }

    const listChange = compareLists(b, a);

    if (
        urlChanged &&
        changedAPageParam(beforeUrl, afterUrl) &&
        listChange.differs
    ) {
        return {
            ...base,
            ...listChange.flags,
            kind: 'pagination',
            detail: 'a paging parameter changed and the list changed with it',
        };
    }

    if (listChange.differs) {
        // Growth that leaves the existing items untouched is "load more", not a
        // filter: a filter replaces what you are looking at.
        if (listChange.flags.appended) {
            return {
                ...base,
                ...listChange.flags,
                kind: 'pagination',
                detail: `${countAfter - countBefore} more items were appended below the existing ones`,
            };
        }
        return {
            ...base,
            ...listChange.flags,
            kind: 'list-changed',
            detail: listChange.flags.reordered
                ? 'the same items came back in a different order'
                : `the list went from ${countBefore} to ${countAfter} items`,
        };
    }

    if (urlChanged) {
        return {
            ...base,
            kind: 'layout-only',
            detail: 'the URL changed but the list did not',
        };
    }

    if (
        before.domHash !== after.domHash ||
        before.interactiveCount !== after.interactiveCount
    ) {
        return {
            ...base,
            kind: 'layout-only',
            detail: 'something on the page changed, but not the list',
        };
    }

    return { ...base, kind: 'noop', detail: 'nothing changed' };
}

interface ListComparison {
    differs: boolean;
    flags: { reordered: boolean; appended: boolean };
}

function compareLists(
    before: ListFingerprint | null,
    after: ListFingerprint | null,
): ListComparison {
    const still = { reordered: false, appended: false };
    if (!before && !after) return { differs: false, flags: still };
    if (!before || !after) return { differs: true, flags: still };

    const same =
        before.itemCount === after.itemCount &&
        before.itemHashes.every((h, i) => h === after.itemHashes[i]);
    if (same) return { differs: false, flags: still };

    // Everything that was there is still there, in the same order, with more
    // after it.
    const appended =
        after.itemCount > before.itemCount &&
        before.itemHashes.every((h, i) => h === after.itemHashes[i]);

    const reordered =
        !appended &&
        before.itemCount === after.itemCount &&
        sorted(before.itemHashes) === sorted(after.itemHashes);

    return { differs: true, flags: { reordered, appended } };
}

function sorted(hashes: string[]): string {
    return [...hashes].sort().join(',');
}

function changedAPageParam(before: URL | null, after: URL | null): boolean {
    if (!before || !after) return false;
    for (const param of PAGE_PARAMS) {
        if (before.searchParams.get(param) !== after.searchParams.get(param))
            return true;
    }
    return false;
}

function safeUrl(input: string): URL | null {
    try {
        return new URL(input);
    } catch {
        return null;
    }
}
