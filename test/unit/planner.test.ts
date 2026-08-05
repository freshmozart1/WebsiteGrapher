import { describe, expect, it } from "vitest";
import { buildPlan } from "../../src/planner/plan.js";
import { ACTION_COST, findPath } from "../../src/planner/search.js";
import type { SiteGraph } from "../../src/graph/schema.js";
import { bookshopGraph, customTypeGraph } from "../helpers/graphs.js";

describe("findPath", () => {
  it("walks from the entry page to a detail page via a component-sourced edge", () => {
    const g = bookshopGraph();
    const path = findPath(g, "page-home", "page-detail");
    expect(path?.map((s) => s.edge.id)).toEqual([
      "edge-home-to-overview",
      "edge-list-to-detail",
    ]);
  });

  it("returns an empty path for the page you are already on", () => {
    expect(findPath(bookshopGraph(), "page-home", "page-home")).toEqual([]);
  });

  it("returns null when nothing links to the target", () => {
    const g = bookshopGraph();
    g.edges = g.edges.filter((e) => e.id !== "edge-list-to-detail");
    expect(findPath(g, "page-home", "page-detail")).toBeNull();
  });

  it("prefers the cheaper action when two routes reach the same page", () => {
    const g = bookshopGraph();
    // A second route to the detail page that requires filling a search box.
    g.edges.push({
      id: "edge-a-search-route",
      sourceNode: "page-home",
      targetNode: "page-detail",
      action: "fill",
      locator: { placeholder: "Search" },
    });
    expect(ACTION_COST.fill).toBeGreaterThan(ACTION_COST.click * 2 - 1);
    const path = findPath(g, "page-home", "page-detail");
    // Two clicks (cost 4) beat one fill (cost 5), even though it is more steps.
    expect(path?.map((s) => s.edge.id)).toEqual([
      "edge-home-to-overview",
      "edge-list-to-detail",
    ]);
  });

  it("takes the single cheap step over a longer cheap route", () => {
    const g = bookshopGraph();
    g.edges.push({
      id: "edge-direct-nav",
      sourceNode: "page-home",
      targetNode: "page-detail",
      action: "navigate",
      locator: { css: "a.product" },
    });
    const path = findPath(g, "page-home", "page-detail");
    expect(path?.map((s) => s.edge.id)).toEqual(["edge-direct-nav"]);
  });

  it("is deterministic when two routes tie exactly", () => {
    const g = bookshopGraph();
    g.edges.push({
      id: "edge-zzz-alternate",
      sourceNode: "page-home",
      targetNode: "page-overview",
      action: "click",
      locator: { role: "link", name: "All books" },
    });
    const runs = new Set(
      Array.from({ length: 20 }, () =>
        JSON.stringify(findPath(g, "page-home", "page-detail")?.map((s) => s.edge.id)),
      ),
    );
    expect(runs.size).toBe(1);
    expect([...runs][0]).toContain("edge-home-to-overview");
  });
});

describe("buildPlan", () => {
  it("answers the price question with the route from the user's example", () => {
    const plan = buildPlan(bookshopGraph(), { kind: "field", semanticName: "price" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.steps.map((s) => s.description)).toEqual([
      'Click the "Books" link to reach the overview page',
      "Click an item in the list to reach the detail page",
    ]);
    expect(plan.destination.pageType).toBe("detail");
    expect(plan.field?.semanticName).toBe("price");
    expect(plan.field?.locator).toEqual({ css: ".product_main .price_color" });
  });

  it("plans to a page when the question is about navigation, not a value", () => {
    const plan = buildPlan(bookshopGraph(), { kind: "page", pageId: "page-detail" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps).toHaveLength(2);
    expect(plan.field).toBeUndefined();
  });

  it("plans from a goal", () => {
    const plan = buildPlan(bookshopGraph(), { kind: "goal", goalId: "goal-find-price" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.field?.id).toBe("field-price");
  });

  it("resolves a field that exists on two pages to the closer one", () => {
    const g = bookshopGraph();
    g.fields.push({
      id: "field-price-overview",
      pageId: "page-overview",
      semanticName: "price",
      locator: { css: "ol.row > li .price_color" },
      verified: true,
      valueShape: "currency",
    });
    const plan = buildPlan(g, { kind: "field", semanticName: "price" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.destination.pageId).toBe("page-overview");
    expect(plan.steps).toHaveLength(1);
  });

  it("flags an unverified position instead of presenting it as certain", () => {
    const g = bookshopGraph();
    g.fields.find((f) => f.id === "field-price")!.verified = false;
    const plan = buildPlan(g, { kind: "field", semanticName: "price" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.notes.join(" ")).toMatch(/only one sample page/);
  });

  describe("gaps", () => {
    it("reports an unknown field with the names that do exist", () => {
      const plan = buildPlan(bookshopGraph(), {
        kind: "field",
        semanticName: "shipping-weight",
      });
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.reason).toMatch(/Nothing named "shipping-weight"/);
      expect(plan.detail.join(" ")).toContain("star-rating");
    });

    it("reports an unreachable page rather than inventing a route", () => {
      const g = bookshopGraph();
      g.edges = g.edges.filter((e) => e.id !== "edge-list-to-detail");
      const plan = buildPlan(g, { kind: "field", semanticName: "price" });
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.reason).toMatch(/no learned route reaches it/);
      expect(plan.detail.join(" ")).toContain("page-detail");
      expect(plan.suggestion).toMatch(/wgraph analyze/);
    });

    it("reports an empty graph", () => {
      const g: SiteGraph = {
        ...bookshopGraph(),
        pages: [],
        components: [],
        edges: [],
        fields: [],
        goals: [],
        entryPageId: "",
      };
      const plan = buildPlan(g, { kind: "field", semanticName: "price" });
      expect(plan.ok).toBe(false);
      if (plan.ok) return;
      expect(plan.reason).toMatch(/empty/);
    });
  });
});

describe("the planner never reads a type string", () => {
  it("plans over a graph built entirely from custom types", () => {
    const plan = buildPlan(customTypeGraph(), {
      kind: "field",
      semanticName: "cost-figure",
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.steps.map((s) => s.toPageId)).toEqual(["page-grid", "page-sheet"]);
    expect(plan.destination.pageType).toBe("record-sheet");
    expect(plan.field?.locator).toEqual({ css: "[data-field=cost]" });
  });

  it("produces the identical route shape when every type is renamed", () => {
    const shape = (g: SiteGraph, field: string) => {
      const plan = buildPlan(g, { kind: "field", semanticName: field });
      return plan.ok ? plan.steps.map((s) => s.action) : null;
    };
    // Same topology, entirely different vocabulary — same plan.
    expect(shape(customTypeGraph(), "cost-figure")).toEqual(
      shape(bookshopGraph(), "price"),
    );
  });
});
