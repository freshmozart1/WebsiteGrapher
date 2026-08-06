import type { Locator, Page } from 'playwright';
import { RESOLUTION_ORDER, type LocatorDefinition } from '../graph/schema.js';

export type Hint = (typeof RESOLUTION_ORDER)[number];

export interface Resolution {
    hint: Hint;
    locator: Locator;
    count: number;
}

type HintResolver = (
    root: Page | Locator,
    def: LocatorDefinition,
) => Locator | null;

const HINT_RESOLVERS: Record<Hint, HintResolver> = {
    role: (root, def) => {
        if (!def.role) return null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const role = def.role as any;
        return def.name
            ? root.getByRole(role, { name: def.name, exact: true })
            : root.getByRole(role);
    },
    label: (root, def) =>
        def.label ? root.getByLabel(def.label, { exact: true }) : null,
    placeholder: (root, def) =>
        def.placeholder ? root.getByPlaceholder(def.placeholder) : null,
    text: (root, def) =>
        def.text ? root.getByText(def.text, { exact: true }) : null,
    css: (root, def) => (def.css ? root.locator(def.css) : null),
    xpath: (root, def) =>
        def.xpath ? root.locator(`xpath=${def.xpath}`) : null,
};

/**
 * Turn one hint of a LocatorDefinition into a Playwright locator.
 * Returns null when the hint is absent or Playwright rejects it (an invalid
 * ARIA role, a malformed selector) — a bad hint must never abort a run.
 */
export function locatorForHint(
    root: Page | Locator,
    def: LocatorDefinition,
    hint: Hint,
): Locator | null {
    try {
        return HINT_RESOLVERS[hint](root, def);
    } catch {
        return null;
    }
}

/**
 * Resolve in the fixed order role -> label -> placeholder -> text -> css ->
 * xpath, preferring the first hint that identifies exactly one element.
 *
 * Falling back through the hints is also what makes locator repair possible
 * later: when a site changes and the primary hint stops matching, the next one
 * is already stored.
 */
export async function resolveLocator(
    root: Page | Locator,
    def: LocatorDefinition,
): Promise<Resolution | null> {
    let ambiguous: Resolution | null = null;

    for (const hint of RESOLUTION_ORDER) {
        const locator = locatorForHint(root, def, hint);
        if (!locator) continue;
        let count: number;
        try {
            count = await locator.count();
        } catch {
            continue;
        }
        if (count === 1) return { hint, locator, count };
        if (count > 1 && !ambiguous) ambiguous = { hint, locator, count };
    }
    return ambiguous;
}

/** The single element a definition points at, or null if it matches none. */
export async function resolveUnique(
    root: Page | Locator,
    def: LocatorDefinition,
): Promise<Locator | null> {
    const resolution = await resolveLocator(root, def);
    if (!resolution) return null;
    return resolution.count === 1
        ? resolution.locator
        : resolution.locator.first();
}
