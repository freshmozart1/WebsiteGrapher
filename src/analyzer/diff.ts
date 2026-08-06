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

interface ChangeContext {
    base: Omit<ChangeClassification, 'kind' | 'detail'>;
    beforeUrl: URL | null;
    afterUrl: URL | null;
    urlChanged: boolean;
    pathChanged: boolean;
    countBefore: number;
    countAfter: number;
    listChange: ListComparison;
    domOrInteractiveChanged: boolean;
}

/** One classification attempt. Returns null when it does not apply, so the
 *  next rule in `CHANGE_RULES` gets a turn. */
type ChangeRule = (ctx: ChangeContext) => ChangeClassification | null;

/** Leaving the page is navigation regardless of what happened to the list. */
const navigationRule: ChangeRule = (ctx) =>
    ctx.pathChanged
        ? {
              ...ctx.base,
              kind: 'navigation',
              detail: `moved from ${ctx.beforeUrl?.pathname ?? '?'} to ${ctx.afterUrl?.pathname ?? '?'}`,
          }
        : null;

const paginationParamRule: ChangeRule = (ctx) =>
    ctx.urlChanged &&
    changedAPageParam(ctx.beforeUrl, ctx.afterUrl) &&
    ctx.listChange.differs
        ? {
              ...ctx.base,
              ...ctx.listChange.flags,
              kind: 'pagination',
              detail: 'a paging parameter changed and the list changed with it',
          }
        : null;

const listChangeRule: ChangeRule = (ctx) => {
    if (!ctx.listChange.differs) return null;

    // Growth that leaves the existing items untouched is "load more", not a
    // filter: a filter replaces what you are looking at.
    if (ctx.listChange.flags.appended) {
        return {
            ...ctx.base,
            ...ctx.listChange.flags,
            kind: 'pagination',
            detail: `${ctx.countAfter - ctx.countBefore} more items were appended below the existing ones`,
        };
    }
    return {
        ...ctx.base,
        ...ctx.listChange.flags,
        kind: 'list-changed',
        detail: ctx.listChange.flags.reordered
            ? 'the same items came back in a different order'
            : `the list went from ${ctx.countBefore} to ${ctx.countAfter} items`,
    };
};

const urlOnlyChangeRule: ChangeRule = (ctx) =>
    ctx.urlChanged
        ? {
              ...ctx.base,
              kind: 'layout-only',
              detail: 'the URL changed but the list did not',
          }
        : null;

const domChangeRule: ChangeRule = (ctx) =>
    ctx.domOrInteractiveChanged
        ? {
              ...ctx.base,
              kind: 'layout-only',
              detail: 'something on the page changed, but not the list',
          }
        : null;

/** Checked in order; the first rule that applies decides the classification. */
const CHANGE_RULES: ChangeRule[] = [
    navigationRule,
    paginationParamRule,
    listChangeRule,
    urlOnlyChangeRule,
    domChangeRule,
];

export function classifyChange(
    before: PageFingerprint,
    after: PageFingerprint,
): ChangeClassification {
    const beforeUrl = safeUrl(before.url);
    const afterUrl = safeUrl(after.url);
    const urlChanged = before.url !== after.url;
    const countBefore = before.list?.itemCount ?? 0;
    const countAfter = after.list?.itemCount ?? 0;

    const ctx: ChangeContext = {
        base: {
            urlChanged,
            itemCountBefore: countBefore,
            itemCountAfter: countAfter,
            reordered: false,
            appended: false,
        },
        beforeUrl,
        afterUrl,
        urlChanged,
        pathChanged: beforeUrl?.pathname !== afterUrl?.pathname,
        countBefore,
        countAfter,
        listChange: compareLists(before.list, after.list),
        domOrInteractiveChanged:
            before.domHash !== after.domHash ||
            before.interactiveCount !== after.interactiveCount,
    };

    for (const rule of CHANGE_RULES) {
        const result = rule(ctx);
        if (result) return result;
    }

    return { ...ctx.base, kind: 'noop', detail: 'nothing changed' };
}

interface ListComparison {
    differs: boolean;
    flags: { reordered: boolean; appended: boolean };
}

function itemsUnchanged(before: ListFingerprint, after: ListFingerprint): boolean {
    return (
        before.itemCount === after.itemCount &&
        before.itemHashes.every((h, i) => h === after.itemHashes[i])
    );
}

/** Everything that was there is still there, in the same order, with more after it. */
function itemsAppended(before: ListFingerprint, after: ListFingerprint): boolean {
    return (
        after.itemCount > before.itemCount &&
        before.itemHashes.every((h, i) => h === after.itemHashes[i])
    );
}

function itemsReordered(
    before: ListFingerprint,
    after: ListFingerprint,
    appended: boolean,
): boolean {
    return (
        !appended &&
        before.itemCount === after.itemCount &&
        sorted(before.itemHashes) === sorted(after.itemHashes)
    );
}

function compareLists(
    before: ListFingerprint | null,
    after: ListFingerprint | null,
): ListComparison {
    const still = { reordered: false, appended: false };
    if (!before && !after) return { differs: false, flags: still };
    if (!before || !after) return { differs: true, flags: still };

    if (itemsUnchanged(before, after)) return { differs: false, flags: still };

    const appended = itemsAppended(before, after);
    const reordered = itemsReordered(before, after, appended);

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
