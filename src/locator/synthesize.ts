import type { Page } from 'playwright';
import { RESOLUTION_ORDER, type LocatorDefinition } from '../graph/schema.js';
import {
    accessibleName,
    type NormalizedElement,
} from '../analyzer/elements.js';
import { locatorForHint } from './resolve.js';

/**
 * Build a LocatorDefinition for an observed element, keeping every hint that
 * actually works.
 *
 * The hints are a ranked set, not alternatives: storing all of them is what
 * lets a later repair pass fall through to the next one when a site changes,
 * without re-learning the page.
 */
function proposeLocator(el: NormalizedElement): LocatorDefinition {
    const def: LocatorDefinition = {};
    const name = accessibleName(el);

    if (el.role) {
        def.role = el.role;
        if (name) def.name = name;
    }
    if (el.label) def.label = el.label;
    if (el.placeholder) def.placeholder = el.placeholder;
    if (el.text && el.text.length <= 40 && el.tag !== 'input')
        def.text = el.text;
    if (el.cssPath) def.css = el.cssPath;

    return def;
}

/**
 * Keep only the hints that resolve to exactly one element on this page, so a
 * stored locator is never ambiguous the moment it is written.
 *
 * A definition that ends up with no unique hint is returned as null: it is
 * better to store nothing than a locator that silently matches the wrong
 * element later.
 */
export async function verifyLocator(
    page: Page,
    proposed: LocatorDefinition,
): Promise<LocatorDefinition | null> {
    const kept: LocatorDefinition = {};
    let anyUnique = false;

    for (const hint of RESOLUTION_ORDER) {
        const locator = locatorForHint(page, proposed, hint);
        if (!locator) continue;
        let count: number;
        try {
            count = await locator.count();
        } catch {
            continue;
        }
        if (count !== 1) continue;

        anyUnique = true;
        if (hint === 'role') {
            kept.role = proposed.role;
            if (proposed.name) kept.name = proposed.name;
        } else {
            kept[hint] = proposed[hint];
        }
    }

    return anyUnique ? kept : null;
}

/** Propose then verify, in one step. */
export async function synthesizeLocator(
    page: Page,
    el: NormalizedElement,
): Promise<LocatorDefinition | null> {
    return await verifyLocator(page, proposeLocator(el));
}

/**
 * A locator for a position rather than a value: used for detail-page fields,
 * where a text or accessible-name hint would pin the field to one item's
 * content.
 */
export function proposeStructuralLocator(
    el: NormalizedElement,
): LocatorDefinition {
    const def: LocatorDefinition = {};
    if (el.role) def.role = el.role;
    if (el.label) def.label = el.label;
    if (el.placeholder) def.placeholder = el.placeholder;
    if (el.cssPath) def.css = el.cssPath;
    return def;
}
