import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPage } from '../../src/browser/session.js';
import { observePage, primaryCluster } from '../../src/analyzer/observe.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';

let site: FixtureSite;

beforeAll(async () => {
    site = await startFixtureSite();
});

afterAll(async () => {
    await site.close();
});

describe('the helpers reach every document the analyzer looks at', () => {
    it('is there on the first page load', async () => {
        const present = await withPage(
            { url: `${site.url}/index.html` },
            (page) =>
                page.evaluate(
                    () => typeof window.__wgraph?.cssPathOf === 'function',
                ),
        );
        expect(present).toBe(true);
    });

    it('is still there after navigating away, and after going back', async () => {
        await withPage({ url: `${site.url}/index.html` }, async (page) => {
            // A learn run navigates many times; an init script that only applied to
            // the first document would leave every later analyzer call throwing.
            await page.goto(`${site.url}/products.html`, {
                waitUntil: 'domcontentloaded',
            });
            expect(
                await page.evaluate(
                    () => typeof window.__wgraph?.cssPathOf === 'function',
                ),
            ).toBe(true);

            await page.goto(`${site.url}/product/1.html`, {
                waitUntil: 'domcontentloaded',
            });
            expect(
                await page.evaluate(
                    () => typeof window.__wgraph?.cssPathOf === 'function',
                ),
            ).toBe(true);

            await page.goBack({ waitUntil: 'domcontentloaded' });
            expect(
                await page.evaluate(
                    () => typeof window.__wgraph?.cssPathOf === 'function',
                ),
            ).toBe(true);
        });
    });

    it("keeps out of the page's own view of its globals", async () => {
        const footprint = await withPage(
            { url: `${site.url}/index.html` },
            (page) =>
                page.evaluate(() => ({
                    enumerable: Object.keys(window).includes('__wgraph'),
                    forIn: (() => {
                        for (const key in window)
                            if (key === '__wgraph') return true;
                        return false;
                    })(),
                })),
        );
        expect(footprint).toEqual({ enumerable: false, forIn: false });
    });
});

describe('cssPathOf', () => {
    it('prefers a unique id', async () => {
        const path = await withPage(
            { url: `${site.url}/products.html` },
            (page) =>
                page.evaluate(() => {
                    document.body.insertAdjacentHTML(
                        'beforeend',
                        `<div id="only-one"></div>`,
                    );
                    return window.__wgraph.cssPathOf(
                        document.querySelector('#only-one')!,
                    );
                }),
        );
        expect(path).toBe('#only-one');
    });

    it('falls back to a positional path that resolves to the element again', async () => {
        const result = await withPage(
            { url: `${site.url}/products.html` },
            (page) =>
                page.evaluate(() => {
                    const target =
                        document.querySelectorAll('li.product-card')[2]!;
                    const css = target.getAttribute('id')
                        ? null
                        : window.__wgraph.cssPathOf(target);
                    return {
                        css,
                        roundTrips: css
                            ? document.querySelector(css) === target
                            : false,
                    };
                }),
        );
        expect(result.css).toContain('nth-of-type');
        expect(result.roundTrips).toBe(true);
    });

    it('uses a test id only when the caller asks for one', async () => {
        const paths = await withPage(
            { url: `${site.url}/products.html` },
            (page) =>
                page.evaluate(() => {
                    document.body.insertAdjacentHTML(
                        'beforeend',
                        `<div><span data-testid="pick-me"></span></div>`,
                    );
                    const el = document.querySelector(
                        '[data-testid="pick-me"]',
                    )!;
                    return {
                        withOption: window.__wgraph.cssPathOf(el, {
                            preferTestId: true,
                        }),
                        without: window.__wgraph.cssPathOf(el),
                    };
                }),
        );
        // The element extractor opts in; the container and field scanners do not,
        // which is the divergence the three copies had drifted into by accident.
        expect(paths.withOption).toBe('[data-testid="pick-me"]');
        expect(paths.without).not.toContain('data-testid');
        expect(paths.without).toContain('span');
    });
});

describe('landmarkOf', () => {
    it('reports an explicit role as the tag it stands for', async () => {
        const found = await withPage(
            { url: `${site.url}/index.html` },
            (page) =>
                page.evaluate(() => {
                    document.body.insertAdjacentHTML(
                        'beforeend',
                        `<div role="navigation"><a id="in-role-nav" href="/x">x</a></div>`,
                    );
                    return window.__wgraph.landmarkOf(
                        document.querySelector('#in-role-nav')!,
                    );
                }),
        );
        expect(found).toBe('nav');
    });

    it('skips past landmarks the caller did not ask about, rather than stopping', async () => {
        const found = await withPage(
            { url: `${site.url}/index.html` },
            (page) =>
                page.evaluate(() => {
                    document.body.insertAdjacentHTML(
                        'beforeend',
                        `<footer><aside><a id="deep" href="/x">x</a></aside></footer>`,
                    );
                    const el = document.querySelector('#deep')!;
                    return {
                        all: window.__wgraph.landmarkOf(el),
                        chromeOnly: window.__wgraph.landmarkOf(el, [
                            'nav',
                            'header',
                            'footer',
                        ]),
                    };
                }),
        );
        // Something inside <aside> inside <footer> is still in the footer. Halting
        // at <aside> would let footer clusters through the exclusion check.
        expect(found.all).toBe('aside');
        expect(found.chromeOnly).toBe('footer');
    });
});

describe("the shared helpers leave the analyzers' output alone", () => {
    it('still excludes the header nav and keeps the list in <main>', async () => {
        const obs = await withPage(
            { url: `${site.url}/products.html` },
            (page) => observePage(page),
        );

        const top = primaryCluster(obs.clusters)!;
        expect(top.itemCss).toBe('li.product-card');
        expect(top.excluded).toBe(false);
        // Inside <main>, which is not site chrome, so it carries no landmark.
        expect(top.landmark).toBeNull();

        const chrome = obs.clusters.filter(
            (c) => c.excluded && c.landmark !== null,
        );
        expect(chrome.length).toBeGreaterThan(0);
        // Normalized to tag names, so the reason reads as real HTML.
        for (const cluster of chrome) {
            expect(['nav', 'header', 'footer']).toContain(cluster.landmark);
            expect(cluster.exclusionReason).toBe(
                `sits inside <${cluster.landmark}>, so it is navigation rather than a list of items`,
            );
        }
    });
});
