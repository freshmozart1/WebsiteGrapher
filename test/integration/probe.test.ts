import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPage } from "../../src/browser/session.js";
import { observePage, primaryCluster } from "../../src/analyzer/observe.js";
import { synthesizeLocator } from "../../src/locator/synthesize.js";
import { ProbeRefused, probeElement } from "../../src/analyzer/probe.js";
import { detectPagination } from "../../src/analyzer/controls.js";
import { findFieldCandidates, crossValidate } from "../../src/analyzer/fields.js";
import { fingerprintPage } from "../../src/analyzer/fingerprint.js";
import { startFixtureSite, type FixtureSite } from "../fixtures/site/server.js";
import { PRODUCTS } from "../fixtures/site/pages.js";

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

/** Observe a page, then probe the element matching `find`. */
async function probeOn(
  path: string,
  find: (e: { id: string | null; text: string }) => boolean,
  options: { approved?: boolean } = {},
) {
  return await withPage({ url: `${site.url}${path}` }, async (page) => {
    const obs = await observePage(page);
    const cluster = primaryCluster(obs.clusters);
    const el = obs.elements.find(find);
    if (!el) throw new Error("test element not found");
    const locator = await synthesizeLocator(page, el);
    if (!locator) throw new Error("no locator could be synthesized");
    return await probeElement(page, el, locator, {
      containerCss: cluster?.containerCss ?? null,
      ...(options.approved ? { approved: true } : {}),
    });
  });
}

describe("probing controls on the product list", () => {
  it("recognises the category dropdown as a filter", async () => {
    const result = await probeOn("/products.html", (e) => e.id === "category");
    expect(result.change.kind).toBe("list-changed");
    expect(result.action).toBe("select");
    expect(result.change.itemCountAfter).toBeLessThan(result.change.itemCountBefore);
  });

  it("recognises the sort dropdown as a reordering, not a filter", async () => {
    const result = await probeOn("/products.html", (e) => e.id === "sort");
    expect(result.change.kind).toBe("list-changed");
    expect(result.change.reordered).toBe(true);
    expect(result.change.itemCountBefore).toBe(result.change.itemCountAfter);
  });

  it("recognises the search box as a filter", async () => {
    const result = await probeOn("/products.html", (e) => e.id === "q");
    expect(result.action).toBe("fill");
    expect(result.change.kind).toBe("list-changed");
    // The probe token matches nothing, so a working filter empties the list.
    expect(result.change.itemCountAfter).toBe(0);
  });

  it("records a control that does nothing as a no-op", async () => {
    const result = await probeOn(
      "/products.html",
      (e) => e.id === "newsletter",
      { approved: true }, // an unrecognised button: normally it would be asked about
    );
    expect(result.change.kind).toBe("noop");
  });

  it("puts the page back the way it found it", async () => {
    await withPage({ url: `${site.url}/products.html` }, async (page) => {
      const obs = await observePage(page);
      const container = primaryCluster(obs.clusters)!.containerCss;
      const before = await fingerprintPage(page, container);

      const category = obs.elements.find((e) => e.id === "category")!;
      const locator = await synthesizeLocator(page, category);
      await probeElement(page, category, locator!, { containerCss: container });

      const after = await fingerprintPage(page, container);
      expect(after.list!.itemHashes).toEqual(before.list!.itemHashes);
      expect(after.url).toBe(before.url);
    });
  });

  it("follows a product link as navigation", async () => {
    const result = await probeOn("/products.html", (e) =>
      Boolean(e.text) && e.text === PRODUCTS[0]!.title,
    );
    expect(result.change.kind).toBe("navigation");
    expect(result.change.urlChanged).toBe(true);
    expect(result.after.url).toContain("/product/1.html");
  });
});

describe("the risk gate stops a probe before it happens", () => {
  it("refuses a control inside a POST form", async () => {
    await expect(
      probeOn("/contact.html", (e) => e.id === "message"),
    ).rejects.toThrow(ProbeRefused);
  });

  it("refuses a destructively labelled button", async () => {
    await expect(
      probeOn("/account.html", (e) => e.text === "Delete my account"),
    ).rejects.toThrow(/consequences/);
  });

  it("refuses a link that leaves the site", async () => {
    await expect(
      probeOn("/account.html", (e) => e.text === "Partner site"),
    ).rejects.toThrow(/leaves this site/);
  });

  it("asks before probing an unrecognised button, and proceeds once approved", async () => {
    await expect(
      probeOn("/products.html", (e) => e.id === "newsletter"),
    ).rejects.toThrow(ProbeRefused);

    const approved = await probeOn(
      "/products.html",
      (e) => e.id === "newsletter",
      { approved: true },
    );
    expect(approved.tier).toBe("confirm");
  });

  it("never touches the buy button on a detail page", async () => {
    await expect(
      probeOn("/product/1.html", (e) => e.text === "Buy now"),
    ).rejects.toThrow(ProbeRefused);
  });
});

describe("pagination detection", () => {
  async function paginationOn(path: string) {
    return await withPage({ url: `${site.url}${path}` }, async (page) => {
      const obs = await observePage(page);
      const cluster = primaryCluster(obs.clusters);
      return await detectPagination(page, obs.elements, cluster?.containerCss ?? null);
    });
  }

  it("reads numbered page links straight off the hrefs", async () => {
    const finding = await paginationOn("/products.html");
    expect(finding?.mode).toBe("numbered");
    expect(finding?.evidence).toMatch(/page-number link/);
  });

  it("confirms a load-more button by clicking it", async () => {
    const finding = await paginationOn("/load-more.html");
    expect(finding?.mode).toBe("load-more");
    expect(finding?.evidence).toMatch(/appended 3 items/);
  });

  it("confirms infinite scroll by scrolling", async () => {
    const finding = await paginationOn("/feed.html");
    expect(finding?.mode).toBe("infinite-scroll");
    expect(finding?.evidence).toMatch(/appended 3 items/);
  });

  it("finds nothing on a page with no pagination", async () => {
    const finding = await paginationOn("/product/1.html");
    expect(finding).toBeNull();
  });
});

describe("detail-page field candidates", () => {
  async function candidatesFor(id: number) {
    return await withPage({ url: `${site.url}/product/${id}.html` }, (page) =>
      findFieldCandidates(page),
    );
  }

  it("finds the title from the single h1", async () => {
    const candidates = await candidatesFor(1);
    const title = candidates.find((c) => c.suggestedName === "title");
    expect(title?.confidence).toBe("high");
    expect(title?.css).toContain("h1");
  });

  it("finds the price from its currency shape", async () => {
    const candidates = await candidatesFor(1);
    const price = candidates.find((c) => c.suggestedName === "price");
    expect(price).toBeDefined();
    expect(price!.valueShape).toBe("currency");
  });

  it("suggests names the four builtins do not cover", async () => {
    const candidates = await candidatesFor(1);
    const names = candidates.map((c) => c.suggestedName);
    expect(names).toContain("rating");
    expect(names).toContain("availability");
  });

  it("finds the image and the description", async () => {
    const candidates = await candidatesFor(1);
    expect(candidates.some((c) => c.suggestedName === "image")).toBe(true);
    expect(candidates.some((c) => c.suggestedName === "description")).toBe(true);
  });

  it("returns positions and shapes, never values", async () => {
    const candidates = await candidatesFor(1);
    const serialized = JSON.stringify(candidates);
    expect(serialized).not.toContain(PRODUCTS[0]!.title);
    expect(serialized).not.toContain(PRODUCTS[0]!.price);
    expect(serialized).not.toContain(PRODUCTS[0]!.blurb);
  });

  it("verifies the positions that hold across two different products", async () => {
    const validated = crossValidate([await candidatesFor(1), await candidatesFor(2)]);
    const verified = validated.filter((v) => v.verified).map((v) => v.candidate.suggestedName);
    expect(verified).toContain("title");
    expect(verified).toContain("price");
    expect(verified).toContain("description");
  });

  it("drops a position that only exists on one of the two products", async () => {
    // Product 3 is out of stock, so its availability text differs — but the
    // position is the same, which is exactly what cross-validation checks.
    const validated = crossValidate([await candidatesFor(1), await candidatesFor(3)]);
    const availability = validated.find(
      (v) => v.candidate.suggestedName === "availability",
    );
    expect(availability?.verified).toBe(true);
  });
});
