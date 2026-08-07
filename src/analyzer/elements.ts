import type { Page } from 'playwright';
import type { DomHelpers } from '../browser/dom-helpers.js';

/**
 * A normalized view of every interactive element on a page.
 *
 * This is the only thing the rest of the analyzer reads. It is produced by one
 * `page.evaluate`, contains no page prose beyond control labels, and never
 * depends on the accessibility tree.
 */
export interface NormalizedElement {
    /** Stable within one observation, so other commands can refer back to it. */
    ref: string;
    tag: string;
    /** Explicit `role`, else the implicit role for the tag. */
    role: string | null;
    /** The control's own label, capped. Not page content. */
    text: string;
    href: string | null;
    label: string | null;
    placeholder: string | null;
    ariaLabel: string | null;
    testId: string | null;
    id: string | null;
    name: string | null;
    type: string | null;
    disabled: boolean;
    visible: boolean;
    boundingBox: { x: number; y: number; width: number; height: number } | null;
    /** Unique CSS selector, the locator hint of last resort. */
    cssPath: string;
    /** Set when the element sits inside a form — the single most important
     *  signal for risk tiering. */
    form: { method: string; action: string } | null;
    /** Nearest landmark ancestor (nav, header, footer, main, aside). Tells a
     *  site's own map apart from its small print. */
    landmark: string | null;
    classes: string[];
}

/** Guards against pathological pages; 400 controls is far past any real page. */
const MAX_ELEMENTS = 400;
const MAX_TEXT = 80;

export async function extractElements(
    page: Page,
): Promise<NormalizedElement[]> {
    return await page.evaluate(
        ({ maxElements, maxText }) => {
            const SELECTOR =
                'a[href], button, input, select, textarea, summary, label, [role], [onclick], [tabindex]';

            const IMPLICIT_ROLE: Record<string, string> = {
                a: 'link',
                button: 'button',
                select: 'combobox',
                textarea: 'textbox',
                summary: 'button',
                h1: 'heading',
                h2: 'heading',
                h3: 'heading',
            };

            const INPUT_ROLE: Record<string, string> = {
                button: 'button',
                submit: 'button',
                reset: 'button',
                checkbox: 'checkbox',
                radio: 'radio',
                range: 'slider',
                search: 'searchbox',
                email: 'textbox',
                tel: 'textbox',
                text: 'textbox',
                url: 'textbox',
                number: 'spinbutton',
            };

            function roleOf(el: Element): string | null {
                const explicit = el.getAttribute('role');
                if (explicit) return explicit;
                const tag = el.tagName.toLowerCase();
                if (tag === 'input') {
                    const type = (el as HTMLInputElement).type.toLowerCase();
                    return INPUT_ROLE[type] ?? 'textbox';
                }
                return IMPLICIT_ROLE[tag] ?? null;
            }

            function labelFor(el: Element): string | null {
                const id = el.getAttribute('id');
                if (id) {
                    const escaped =
                        typeof CSS !== 'undefined' && CSS.escape
                            ? CSS.escape(id)
                            : id;
                    const explicit = document.querySelector(
                        `label[for="${escaped}"]`,
                    );
                    if (explicit?.textContent)
                        return explicit.textContent.trim().slice(0, maxText);
                }
                const wrapping = el.closest('label');
                if (wrapping?.textContent)
                    return wrapping.textContent.trim().slice(0, maxText);
                return null;
            }

            const wg: DomHelpers = window.__wgraph;

            function formOf(
                el: Element,
            ): { method: string; action: string } | null {
                const form = el.closest('form');
                if (!form) return null;
                return {
                    method: (
                        form.getAttribute('method') ?? 'get'
                    ).toLowerCase(),
                    action: form.getAttribute('action') ?? '',
                };
            }

            function isHiddenInput(el: Element): boolean {
                return (
                    el.tagName.toLowerCase() === 'input' &&
                    (el as HTMLInputElement).type === 'hidden'
                );
            }

            function buildNormalizedElement(
                el: Element,
                index: number,
            ): NormalizedElement {
                const box = el.getBoundingClientRect();
                return {
                    ref: `e${index + 1}`,
                    tag: el.tagName.toLowerCase(),
                    role: roleOf(el),
                    text: (el.textContent ?? '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, maxText),
                    href: el instanceof HTMLAnchorElement ? el.href : null,
                    label: labelFor(el),
                    placeholder: el.getAttribute('placeholder'),
                    ariaLabel: el.getAttribute('aria-label'),
                    testId: el.getAttribute('data-testid'),
                    id: el.getAttribute('id'),
                    name: el.getAttribute('name'),
                    type: el.getAttribute('type'),
                    disabled:
                        el.hasAttribute('disabled') ||
                        el.getAttribute('aria-disabled') === 'true',
                    visible: wg.isVisible(el),
                    boundingBox:
                        box.width > 0 || box.height > 0
                            ? {
                                  x: box.x,
                                  y: box.y,
                                  width: box.width,
                                  height: box.height,
                              }
                            : null,
                    cssPath: wg.cssPathOf(el, { preferTestId: true }),
                    form: formOf(el),
                    landmark: wg.landmarkOf(el),
                    classes: Array.prototype.slice.call(
                        el.classList,
                    ) as string[],
                };
            }

            const seen = new Set<Element>();
            const out: NormalizedElement[] = [];

            const candidates = Array.prototype.slice.call(
                document.querySelectorAll(SELECTOR),
            ) as Element[];

            for (const el of candidates) {
                if (out.length >= maxElements) break;
                if (seen.has(el)) continue;
                seen.add(el);
                if (isHiddenInput(el)) continue;

                out.push(buildNormalizedElement(el, out.length));
            }

            return out;
        },
        { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT },
    );
}

/** The accessible name a role-based locator would match. */
export function accessibleName(el: NormalizedElement): string | null {
    return el.ariaLabel ?? el.label ?? (el.text.length > 0 ? el.text : null);
}
