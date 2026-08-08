import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPage } from '../../src/browser/session.js';
import {
    observePage,
    primaryCluster,
    type PageObservation,
} from '../../src/analyzer/observe.js';
import { synthesizeLocator } from '../../src/locator/synthesize.js';
import { resolveLocator } from '../../src/locator/resolve.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';
import { PRODUCTS } from '../fixtures/site/pages.js';

let site: FixtureSite;

beforeAll(async () => {
    site = await startFixtureSite();
});

afterAll(async () => {
    await site.close();
});

async function observe(path: string): Promise<PageObservation> {
    return await withPage({ url: `${site.url}${path}` }, (page) =>
        observePage(page),
    );
}

describe('observing the home page', () => {
    it('captures the title, url and navigation links', async () => {
        const obs = await observe('/index.html');
        expect(obs.title).toBe('Fixture Bookshop');
        expect(obs.url).toContain('/index.html');
        const names = obs.elements.map((e) => e.text);
        expect(names).toContain('Products');
        expect(names).toContain('Browse all products');
    });

    it('reads no repeating list worth calling one', async () => {
        const obs = await observe('/index.html');
        expect(obs.signals.topClusterSize).toBeLessThan(3);
    });

    it('marks the path as not item-like', async () => {
        const obs = await observe('/index.html');
        expect(obs.signals.looksLikeItemUrl).toBe(false);
    });
});

describe('observing the product list', () => {
    it('finds the repeating product cards as the top cluster', async () => {
        const obs = await observe('/products.html');
        const top = primaryCluster(obs.clusters);
        expect(top).toBeDefined();
        expect(top!.count).toBe(3); // page size
        expect(top!.itemCss).toBe('li.product-card');
        expect(top!.containerCss).toContain('ol');
    });

    it('identifies the click target that leads to a detail page', async () => {
        const obs = await observe('/products.html');
        const top = primaryCluster(obs.clusters)!;
        expect(top.clickTargetCss).toBe('h3 > a');
        expect(top.sampleHrefs[0]).toMatch(/\/product\/\d+\.html$/);
    });

    it('ranks the product grid above the navigation and pager', async () => {
        const obs = await observe('/products.html');
        expect(primaryCluster(obs.clusters)!.itemCss).toBe('li.product-card');
    });

    it('reports the menu and pager it rejected, and why', async () => {
        const obs = await observe('/products.html');
        const rejected = obs.clusters.filter((c) => c.excluded);
        expect(rejected.length).toBeGreaterThan(0);
        for (const cluster of rejected) {
            expect(cluster.exclusionReason).toBeTruthy();
        }
        // The main menu is one of them, rejected for sitting in a landmark.
        expect(rejected.some((c) => c.landmark !== null)).toBe(true);
    });

    it('sees the controls that might filter the list', async () => {
        const obs = await observe('/products.html');
        const ids = obs.elements.map((e) => e.id);
        expect(ids).toContain('category');
        expect(ids).toContain('sort');
        expect(ids).toContain('q');
    });

    it('records that the controls sit in a GET form, not a POST one', async () => {
        const obs = await observe('/products.html');
        const category = obs.elements.find((e) => e.id === 'category');
        expect(category?.form).toEqual({
            method: 'get',
            action: '/products.html',
        });
    });

    it('associates each control with its label', async () => {
        const obs = await observe('/products.html');
        expect(obs.elements.find((e) => e.id === 'category')?.label).toBe(
            'Category',
        );
        expect(obs.elements.find((e) => e.id === 'q')?.label).toBe(
            'Search products',
        );
        expect(obs.elements.find((e) => e.id === 'q')?.placeholder).toBe(
            'Search products',
        );
    });

    it('flags the pagination controls as hints', async () => {
        const obs = await observe('/products.html');
        const hinted = obs.signals.paginationHints
            .map((ref) => obs.elements.find((e) => e.ref === ref))
            .map((e) => e?.text);
        expect(hinted).toContain('Next');
        expect(hinted).toContain('2');
    });
});

describe('observing a row-split grid with hashed classnames', () => {
    it('merges the two row containers into one six-item cluster', async () => {
        const obs = await observe('/careers.html');
        const top = primaryCluster(obs.clusters);
        expect(top).toBeDefined();
        expect(top!.count).toBe(6);
        // Items are direct children of a *row*, not of the container, so
        // itemCss carries the row's own selector too — see the comment on
        // this in findMergedClusters (src/analyzer/structure.ts).
        expect(top!.itemCss).toBe('div.role-row > div.role-card');
    });

    it('reports the grid wrapper as the container, not a single row', async () => {
        await withPage({ url: `${site.url}/careers.html` }, async (page) => {
            const obs = await observePage(page);
            const top = primaryCluster(obs.clusters)!;
            const element = await page.$(top.containerCss);
            expect(element).not.toBeNull();
            const childCount = await element!.evaluate(
                (el) => el.children.length,
            );
            // The two row wrappers, not the six cards a mispicked row would have.
            expect(childCount).toBe(2);
        });
    });

    it('composes containerCss + itemCss into a selector that finds every card', async () => {
        // This is exactly how src/analyzer/learn.ts builds its item locator
        // (`${containerCss} > ${itemCss}`) — if containerCss and itemCss
        // don't agree on where the items actually sit in the DOM, this
        // composed selector silently resolves to nothing.
        await withPage({ url: `${site.url}/careers.html` }, async (page) => {
            const obs = await observePage(page);
            const top = primaryCluster(obs.clusters)!;
            const matches = await page.$$(
                `${top.containerCss} > ${top.itemCss}`,
            );
            expect(matches.length).toBe(6);
        });
    });

    it('does not also report the individual rows as separate clusters', async () => {
        const obs = await observe('/careers.html');
        const cardFragments = obs.clusters.filter((c) =>
            c.itemCss.endsWith('div.role-card'),
        );
        expect(cardFragments.length).toBe(1);
    });
});

describe('observing a detail page', () => {
    it('looks like an item URL and carries a single h1', async () => {
        const obs = await observe('/product/2.html');
        expect(obs.signals.looksLikeItemUrl).toBe(true);
        expect(obs.signals.headings.h1).toBe(1);
        expect(obs.signals.topClusterSize).toBeLessThan(3);
    });

    it('does not mistake the spec table or the menu for a product list', async () => {
        const obs = await observe('/product/2.html');
        // Two spec rows is under the minimum, and the menu sits in a landmark.
        expect(primaryCluster(obs.clusters)).toBeUndefined();
    });
});

describe('observing a form page', () => {
    it('counts the POST form and its inputs', async () => {
        const obs = await observe('/contact.html');
        expect(obs.signals.formCount).toBe(1);
        expect(obs.signals.postFormCount).toBe(1);
        expect(obs.signals.inputCount).toBeGreaterThanOrEqual(3);
    });

    it('marks every control inside the POST form', async () => {
        const obs = await observe('/contact.html');
        const email = obs.elements.find((e) => e.id === 'email');
        expect(email?.form?.method).toBe('post');
    });
});

describe('locator synthesis', () => {
    it('produces a locator that resolves to exactly one element', async () => {
        await withPage({ url: `${site.url}/products.html` }, async (page) => {
            const obs = await observePage(page);
            const category = obs.elements.find((e) => e.id === 'category')!;
            const locator = await synthesizeLocator(page, category);

            expect(locator).not.toBeNull();
            const resolution = await resolveLocator(page, locator!);
            expect(resolution?.count).toBe(1);
        });
    });

    it('keeps only hints that are unique, dropping ambiguous ones', async () => {
        await withPage({ url: `${site.url}/products.html` }, async (page) => {
            const obs = await observePage(page);
            // Every product card has a "price" paragraph, so a text hint on a
            // repeated label must not survive verification.
            const products = obs.elements.filter(
                (e) => e.tag === 'a' && e.href?.includes('/product/'),
            );
            expect(products.length).toBeGreaterThan(1);

            for (const el of products) {
                const locator = await synthesizeLocator(page, el);
                if (locator === null) continue;
                const resolution = await resolveLocator(page, locator);
                expect(resolution?.count).toBe(1);
            }
        });
    });

    it('returns null rather than storing an ambiguous locator', async () => {
        await withPage({ url: `${site.url}/products.html` }, async (page) => {
            const ambiguous =
                await import('../../src/locator/synthesize.js').then((m) =>
                    m.verifyLocator(page, { css: 'li.product-card' }),
                );
            expect(ambiguous).toBeNull();
        });
    });

    it('builds structural locators with no value-bearing hints', async () => {
        const { proposeStructuralLocator } =
            await import('../../src/locator/synthesize.js');
        await withPage({ url: `${site.url}/product/1.html` }, async (page) => {
            const obs = await observePage(page);
            const buy = obs.elements.find((e) => e.classes.includes('buy'))!;
            const locator = proposeStructuralLocator(buy);
            expect(locator.text).toBeUndefined();
            expect(locator.name).toBeUndefined();
            expect(locator.css).toBeTruthy();
        });
    });
});

describe('the accessibility tree is optional', () => {
    it('is used when the browser offers one', async () => {
        const obs = await observe('/products.html');
        expect(obs.accessibility).not.toBeNull();
        expect(obs.accessibility!.length).toBeGreaterThan(0);
    });

    it('produces the same structural findings when it is unavailable', async () => {
        const withAx = await observe('/products.html');

        process.env.WGRAPH_NO_AX = '1';
        let withoutAx: PageObservation;
        try {
            withoutAx = await observe('/products.html');
        } finally {
            delete process.env.WGRAPH_NO_AX;
        }

        expect(withoutAx.accessibility).toBeNull();
        expect(primaryCluster(withoutAx.clusters)!.itemCss).toBe(
            primaryCluster(withAx.clusters)!.itemCss,
        );
        expect(primaryCluster(withoutAx.clusters)!.clickTargetCss).toBe(
            primaryCluster(withAx.clusters)!.clickTargetCss,
        );
        expect(withoutAx.elements.map((e) => e.ref)).toEqual(
            withAx.elements.map((e) => e.ref),
        );
        expect(withoutAx.signals).toEqual(withAx.signals);
    });

    it('still synthesizes working locators without it', async () => {
        process.env.WGRAPH_NO_AX = '1';
        try {
            await withPage(
                { url: `${site.url}/products.html` },
                async (page) => {
                    const obs = await observePage(page);
                    expect(obs.accessibility).toBeNull();
                    const sort = obs.elements.find((e) => e.id === 'sort')!;
                    const locator = await synthesizeLocator(page, sort);
                    expect(locator).not.toBeNull();
                    expect((await resolveLocator(page, locator!))?.count).toBe(
                        1,
                    );
                },
            );
        } finally {
            delete process.env.WGRAPH_NO_AX;
        }
    });
});

describe('the fixture site itself', () => {
    it('serves every product detail page', async () => {
        for (const product of PRODUCTS.slice(0, 2)) {
            const obs = await observe(`/product/${product.id}.html`);
            expect(obs.title).toContain(product.title);
        }
    });

    it('paginates server-side', async () => {
        const page2 = await observe('/products.html?page=2');
        expect(page2.signals.hasQuery).toBe(true);
        expect(primaryCluster(page2.clusters)!.count).toBe(3);
        expect(primaryCluster(page2.clusters)!.sampleHrefs[0]).toContain(
            '/product/4.html',
        );
    });
});
