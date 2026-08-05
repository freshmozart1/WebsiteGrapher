import { describe, expect, it } from "vitest";
import { SiteGraphSchema, emptyGraph } from "../../src/graph/schema.js";
import { GraphValidationError, parseGraph } from "../../src/graph/store.js";
import { bookshopGraph, customTypeGraph } from "../helpers/graphs.js";

function issuesOf(graph: unknown): string[] {
  try {
    parseGraph(graph);
    return [];
  } catch (err) {
    if (err instanceof GraphValidationError) return err.issues;
    throw err;
  }
}

describe("SiteGraphSchema", () => {
  it("accepts the fixture graphs", () => {
    expect(SiteGraphSchema.safeParse(bookshopGraph()).success).toBe(true);
    expect(SiteGraphSchema.safeParse(customTypeGraph()).success).toBe(true);
  });

  it("accepts a brand new empty graph", () => {
    expect(SiteGraphSchema.safeParse(emptyGraph("https://example.com")).success).toBe(
      true,
    );
  });

  describe("vocabulary registration", () => {
    it("rejects a page type that was never registered", () => {
      const g = bookshopGraph();
      g.pages[0]!.type = "checkout-step";
      expect(issuesOf(g).join("\n")).toMatch(
        /page type "checkout-step" is not registered/,
      );
    });

    it("rejects an unregistered component type", () => {
      const g = bookshopGraph();
      g.components[0]!.type = "carousel";
      expect(issuesOf(g).join("\n")).toMatch(
        /component type "carousel" is not registered/,
      );
    });

    it("rejects an unregistered field name", () => {
      const g = bookshopGraph();
      g.fields[0]!.semanticName = "isbn";
      expect(issuesOf(g).join("\n")).toMatch(/field name "isbn" is not registered/);
    });

    it("accepts a registered custom value", () => {
      // star-rating and availability are registered by the fixture and used.
      expect(issuesOf(bookshopGraph())).toEqual([]);
    });

    it("rejects a value that is not kebab-case, so no graph grows synonyms", () => {
      const g = bookshopGraph();
      g.vocabulary.pageTypes.push({
        name: "productList",
        description: "x",
        builtin: false,
      });
      g.pages[0]!.type = "productList";
      expect(issuesOf(g).join("\n")).toMatch(/kebab-case/);
    });
  });

  describe("referential integrity", () => {
    it("rejects an entry page that does not exist", () => {
      const g = bookshopGraph();
      g.entryPageId = "page-nope";
      expect(issuesOf(g).join("\n")).toMatch(/is not a known page/);
    });

    it("rejects a component pointing at a missing page", () => {
      const g = bookshopGraph();
      g.components[0]!.pageId = "page-ghost";
      expect(issuesOf(g).join("\n")).toMatch(/unknown page "page-ghost"/);
    });

    it("rejects an edge whose target is a component rather than a page", () => {
      const g = bookshopGraph();
      g.edges[0]!.targetNode = "comp-list";
      expect(issuesOf(g).join("\n")).toMatch(/must be a page/);
    });

    it("rejects a goal pointing at a missing field", () => {
      const g = bookshopGraph();
      g.goals[0]!.targetField = "field-nope";
      expect(issuesOf(g).join("\n")).toMatch(/unknown field "field-nope"/);
    });

    it("rejects duplicate ids across collections", () => {
      const g = bookshopGraph();
      g.components[0]!.id = "page-home";
      expect(issuesOf(g).join("\n")).toMatch(/duplicate id "page-home"/);
    });
  });

  describe("field locators", () => {
    it("rejects a field pinned by the value it displays", () => {
      const g = bookshopGraph();
      g.fields[1]!.locator = { text: "£51.77" };
      expect(issuesOf(g).join("\n")).toMatch(/must be structural/);
    });

    it("rejects a field pinned by accessible name", () => {
      const g = bookshopGraph();
      g.fields[0]!.locator = { role: "heading", name: "A Light in the Attic" };
      expect(issuesOf(g).join("\n")).toMatch(/must be structural/);
    });

    it("allows a structural field locator", () => {
      const g = bookshopGraph();
      g.fields[0]!.locator = { role: "heading", css: ".product_main h1" };
      expect(issuesOf(g)).toEqual([]);
    });
  });

  it("requires a locator to carry at least one hint", () => {
    const g = bookshopGraph();
    g.components[0]!.locator = {};
    expect(issuesOf(g).join("\n")).toMatch(/at least one hint/);
  });
});
