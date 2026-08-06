import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeCommand } from '../../src/cli/commands/observe.js';
import { EXIT, UsageError } from '../../src/cli/exit.js';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/server.js';

let site: FixtureSite;
let out: string[];

beforeAll(async () => {
    site = await startFixtureSite();
});

afterAll(async () => {
    await site.close();
});

beforeEach(() => {
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        out.push(args.join(' '));
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

const printed = () => out.join('\n');

describe('wgraph observe', () => {
    it('requires a target url', async () => {
        await expect(observeCommand([])).rejects.toThrow(UsageError);
    });

    it('reports the draft classification and element counts for a page', async () => {
        const code = await observeCommand([`${site.url}/products.html`]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toContain(`${site.url}/products.html`);
        expect(printed()).toMatch(/Draft page type: overview/);
        expect(printed()).toMatch(/Elements: \d+/);
        expect(printed()).toMatch(/List: 3 x li\.product-card/);
    });

    it('reports when no repeating list is found', async () => {
        const code = await observeCommand([`${site.url}/index.html`]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toContain('List: none found');
    });

    it('emits the same observation as JSON', async () => {
        const code = await observeCommand([
            `${site.url}/products.html`,
            '--json',
        ]);
        expect(code).toBe(EXIT.OK);
        const parsed = JSON.parse(printed());
        expect(parsed.url).toContain('/products.html');
        expect(parsed.draftClassification.type).toBe('overview');
        expect(parsed.primaryCluster.itemCss).toBe('li.product-card');
        expect(Array.isArray(parsed.risk.safe)).toBe(true);
    });

    it('reports field candidates when asked', async () => {
        const code = await observeCommand([
            `${site.url}/product/1.html`,
            '--fields',
        ]);
        expect(code).toBe(EXIT.OK);
        expect(printed()).toMatch(/Field candidates:/);
    });
});
