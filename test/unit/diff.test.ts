import { describe, expect, it } from 'vitest';
import { classifyChange } from '../../src/analyzer/diff.js';
import type { PageFingerprint } from '../../src/analyzer/fingerprint.js';

function fp(
    overrides: Partial<PageFingerprint> & { items?: string[] } = {},
): PageFingerprint {
    const { items, ...rest } = overrides;
    return {
        url: 'https://shop.example/products',
        title: 'Products',
        domHash: 'aaaa1111',
        interactiveCount: 20,
        list:
            items === undefined
                ? {
                      containerCss: 'ol.products',
                      itemCount: 3,
                      itemHashes: ['h1', 'h2', 'h3'],
                      signature: 'sig',
                  }
                : {
                      containerCss: 'ol.products',
                      itemCount: items.length,
                      itemHashes: items,
                      signature: 'sig',
                  },
        ...rest,
    };
}

describe('classifyChange', () => {
    it('calls an identical page a no-op', () => {
        const result = classifyChange(fp(), fp());
        expect(result.kind).toBe('noop');
    });

    it('calls a path change navigation, whatever the list did', () => {
        const result = classifyChange(
            fp(),
            fp({ url: 'https://shop.example/product/2', items: ['x'] }),
        );
        expect(result.kind).toBe('navigation');
        expect(result.detail).toContain('/product/2');
    });

    it('calls a shorter list a filter', () => {
        const result = classifyChange(fp(), fp({ items: ['h1', 'h3'] }));
        expect(result.kind).toBe('list-changed');
        expect(result.itemCountBefore).toBe(3);
        expect(result.itemCountAfter).toBe(2);
        expect(result.reordered).toBe(false);
    });

    it('recognises a sort: same items, different order', () => {
        const result = classifyChange(fp(), fp({ items: ['h3', 'h1', 'h2'] }));
        expect(result.kind).toBe('list-changed');
        expect(result.reordered).toBe(true);
        expect(result.detail).toMatch(/different order/);
    });

    it('recognises load-more: existing items untouched, more appended', () => {
        const result = classifyChange(
            fp(),
            fp({ items: ['h1', 'h2', 'h3', 'h4', 'h5'] }),
        );
        expect(result.kind).toBe('pagination');
        expect(result.appended).toBe(true);
        expect(result.detail).toContain('2 more items');
    });

    it("does not call a replacement of every item 'appended'", () => {
        const result = classifyChange(
            fp(),
            fp({ items: ['z1', 'z2', 'z3', 'z4'] }),
        );
        expect(result.kind).toBe('list-changed');
        expect(result.appended).toBe(false);
    });

    it('recognises pagination from a changed page parameter', () => {
        const result = classifyChange(
            fp({ url: 'https://shop.example/products?page=1' }),
            fp({
                url: 'https://shop.example/products?page=2',
                items: ['h4', 'h5', 'h6'],
            }),
        );
        expect(result.kind).toBe('pagination');
        expect(result.detail).toMatch(/paging parameter/);
    });

    it('treats a non-paging query change with a new list as a filter', () => {
        const result = classifyChange(
            fp({ url: 'https://shop.example/products' }),
            fp({
                url: 'https://shop.example/products?category=tech',
                items: ['h2'],
            }),
        );
        expect(result.kind).toBe('list-changed');
    });

    it('calls a page-parameter change with no list change layout-only', () => {
        const result = classifyChange(
            fp({ url: 'https://shop.example/products?page=1' }),
            fp({ url: 'https://shop.example/products?page=2' }),
        );
        expect(result.kind).toBe('layout-only');
    });

    it('calls a DOM change that spares the list layout-only', () => {
        const result = classifyChange(fp(), fp({ domHash: 'bbbb2222' }));
        expect(result.kind).toBe('layout-only');
        expect(result.detail).toMatch(/not the list/);
    });

    it('notices a dropdown opening through the interactive count', () => {
        const result = classifyChange(fp(), fp({ interactiveCount: 26 }));
        expect(result.kind).toBe('layout-only');
    });

    it('handles a page with no list at all', () => {
        const before: PageFingerprint = { ...fp(), list: null };
        const after: PageFingerprint = { ...fp(), list: null };
        expect(classifyChange(before, after).kind).toBe('noop');
    });

    it('treats a list appearing where there was none as a change', () => {
        const before: PageFingerprint = { ...fp(), list: null };
        expect(classifyChange(before, fp()).kind).toBe('list-changed');
    });
});
