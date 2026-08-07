import type { BrowserContext } from 'playwright';

/**
 * The DOM helpers every `page.evaluate` in the analyzer shares.
 *
 * A function handed to `page.evaluate` is serialized and rebuilt inside the
 * page, so it cannot close over module scope. Each analyzer therefore carried
 * its own copy of `cssPathOf` — and the copies had already drifted: the one in
 * `elements.ts` grew a `data-testid` shortcut that the other two never got.
 *
 * So the helpers are installed once per browser context as an init script and
 * reached through `window.__wgraph`. Playwright re-runs an init script for
 * every document in the context — each new page, each navigation, each child
 * frame — so the object is in place before any page script runs and outlives
 * the many `page.goto` calls a learn run makes.
 *
 * The price is one property on the `window` of a third-party page. It is
 * namespaced, defined non-enumerably so it stays out of `Object.keys(window)`
 * and `for..in`, and it adds no DOM node, no listener and no patched built-in —
 * nothing that perturbs the structure these analyzers are there to measure.
 */
export interface DomHelpers {
    /**
     * A selector that identifies `el` from the document root: its id when that
     * is unique, else a positional path capped at 8 levels.
     *
     * `preferTestId` adds a `data-testid` shortcut between the two. Only the
     * element extractor asks for it, because a test id is the stable hook for a
     * control but says nothing about where a container or a field sits.
     */
    cssPathOf(el: Element, options?: { preferTestId?: boolean }): string;

    /** A short selector from `root` down to `target`, capped at 6 levels. */
    relativePath(root: Element, target: Element): string;

    /**
     * The nearest landmark ancestor, as a tag name — an explicit `role` is
     * normalized to the tag it stands for, so a caller never has to handle
     * "navigation" and "nav" separately.
     *
     * `tags` narrows which landmarks count and defaults to all of them. Passing
     * a subset skips the rest of the ancestor walk rather than stopping at it,
     * which is what a caller asking "is this inside the site chrome?" means: a
     * list inside `<aside>` inside `<footer>` is still in the footer.
     */
    landmarkOf(el: Element, tags?: readonly string[]): string | null;

    /** Whether `el` renders with a nonzero box: not `display: none`,
     *  `visibility: hidden` or fully transparent, and not collapsed by a
     *  hidden ancestor (`getBoundingClientRect` catches that case too). */
    isVisible(el: Element): boolean;
}

declare global {
    interface Window {
        /**
         * Installed by `addDomHelpers` on every context `startRun` opens. Analyzer
         * `page.evaluate` callbacks may assume it is present.
         */
        __wgraph: DomHelpers;
    }
}

/**
 * Serialized by Playwright and run in the page, so it must be self-contained:
 * no imports, no references to anything outside its own body.
 */
function installDomHelpers(): void {
    const LANDMARK_TAGS = ['nav', 'header', 'footer', 'main', 'aside'];
    const LANDMARK_ROLES: Record<string, string> = {
        navigation: 'nav',
        banner: 'header',
        contentinfo: 'footer',
        main: 'main',
        complementary: 'aside',
    };

    /** One step of a positional path: `div`, or `div:nth-of-type(3)` when the
     *  tag alone would not tell this child from its siblings. */
    function segmentFor(node: Element, parent: Element): string {
        const tag = node.tagName.toLowerCase();
        const sameTag = Array.prototype.filter.call(
            parent.children,
            (c: Element) => c.tagName === node.tagName,
        ) as Element[];
        return sameTag.length > 1
            ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
            : tag;
    }

    function uniqueIdSelector(el: Element): string | null {
        const id = el.getAttribute('id');
        return id && document.querySelectorAll(`[id="${id}"]`).length === 1
            ? `#${id}`
            : null;
    }

    function testIdSelector(
        el: Element,
        options?: { preferTestId?: boolean },
    ): string | null {
        if (!options?.preferTestId) return null;
        const testId = el.getAttribute('data-testid');
        return testId ? `[data-testid="${testId}"]` : null;
    }

    function positionalPath(el: Element): string {
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === 1 && parts.length < 8) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'html' || tag === 'body') break;
            const parent: Element | null = node.parentElement;
            if (!parent) {
                parts.unshift(tag);
                break;
            }
            parts.unshift(segmentFor(node, parent));
            node = parent;
        }
        return parts.join(' > ');
    }

    function cssPathOf(
        el: Element,
        options?: { preferTestId?: boolean },
    ): string {
        return (
            uniqueIdSelector(el) ??
            testIdSelector(el, options) ??
            positionalPath(el)
        );
    }

    function relativePath(root: Element, target: Element): string {
        const parts: string[] = [];
        let node: Element | null = target;
        while (node && node !== root && parts.length < 6) {
            const parent: Element | null = node.parentElement;
            if (!parent) break;
            parts.unshift(segmentFor(node, parent));
            node = parent;
        }
        return parts.join(' > ');
    }

    function landmarkOf(el: Element, tags?: readonly string[]): string | null {
        const wanted = tags ?? LANDMARK_TAGS;
        let node: Element | null = el;
        while (node) {
            const tag = node.tagName.toLowerCase();
            if (wanted.indexOf(tag) !== -1) return tag;
            const role = node.getAttribute('role');
            const mapped = role ? LANDMARK_ROLES[role] : undefined;
            if (mapped && wanted.indexOf(mapped) !== -1) return mapped;
            node = node.parentElement;
        }
        return null;
    }

    function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            Number(style.opacity) === 0
        ) {
            return false;
        }
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
    }

    // Non-enumerable, so the page sees as little of us as possible.
    Object.defineProperty(window, '__wgraph', {
        value: { cssPathOf, relativePath, landmarkOf, isVisible },
        configurable: true,
    });
}

/**
 * Call once per context, before the first page is opened. Every analyzer
 * `page.evaluate` depends on this having happened — `startRun` is the only
 * place in the codebase that builds a context, and it is where this belongs.
 */
export async function addDomHelpers(context: BrowserContext): Promise<void> {
    await context.addInitScript(installDomHelpers);
}
