import type { LocatorDefinition } from './schema.js';

/**
 * A short human phrase for a locator, used when rendering a plan:
 *   { role: "link", name: "Products" } -> `the "Products" link`
 */
export function describeLocator(locator: LocatorDefinition): string {
    const label =
        locator.name ?? locator.label ?? locator.text ?? locator.placeholder;
    if (locator.role && label) return `the "${label}" ${locator.role}`;
    if (label) return `"${label}"`;
    if (locator.role) return `the ${locator.role}`;
    if (locator.css) return `\`${compactSelector(locator.css)}\``;
    if (locator.xpath) return `\`${compactSelector(locator.xpath)}\``;
    return 'the element';
}

/**
 * Deep selectors are unreadable in prose. The full selector is always in the
 * `--json` output; this is only for the sentence a person reads.
 */
function compactSelector(selector: string, keep = 3): string {
    const parts = selector.split(' > ');
    if (parts.length <= keep) return selector;
    return `… > ${parts.slice(-keep).join(' > ')}`;
}
