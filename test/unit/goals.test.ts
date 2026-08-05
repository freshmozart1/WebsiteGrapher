import { describe, expect, it } from "vitest";
import { interpretQuestion, tokenize } from "../../src/planner/goals.js";
import { bookshopGraph, customTypeGraph } from "../helpers/graphs.js";

describe("tokenize", () => {
  it("drops question scaffolding and stems plurals", () => {
    expect(tokenize("What steps are necessary to view the product details?")).toEqual(
      ["product", "detail"],
    );
  });
});

describe("interpretQuestion", () => {
  const g = bookshopGraph();

  it("reads the price question as the price goal", () => {
    const result = interpretQuestion(g, "How do I find the price of a product?");
    expect(result.kind).toBe("goal");
    expect(result.goalId).toBe("goal-find-price");
    expect(result.confidence).toBe("high");
  });

  it("reads the navigation question as the detail page, not the price goal", () => {
    // Both candidates share the token "product"; only the page shares "detail".
    const result = interpretQuestion(
      g,
      "What steps are necessary to view the product details?",
    );
    expect(result.kind).toBe("page");
    expect(result.pageId).toBe("page-detail");
    expect(result.confidence).toBe("high");
  });

  it("matches a custom field name on its own tokens", () => {
    const result = interpretQuestion(g, "Where is the star rating shown?");
    expect(result.kind).toBe("field");
    expect(result.semanticName).toBe("star-rating");
  });

  it("matches the other custom field name", () => {
    const result = interpretQuestion(g, "How can I check availability?");
    expect(result.kind).toBe("field");
    expect(result.semanticName).toBe("availability");
  });

  it("matches a builtin field through a synonym, with lower confidence", () => {
    const result = interpretQuestion(g, "How much does it cost?");
    expect(result.kind).toBe("field");
    expect(result.semanticName).toBe("price");
    expect(result.confidence).not.toBe("high");
  });

  it("prefers the field over the page when they tie", () => {
    const result = interpretQuestion(g, "Where is the cover image?");
    expect(result.kind).toBe("field");
    expect(result.semanticName).toBe("image");
  });

  it("reports no match rather than guessing", () => {
    const result = interpretQuestion(g, "What is the delivery lead time?");
    expect(result.kind).toBe("none");
    expect(result.confidence).toBe("low");
  });

  it("reports no match for a question with only stopwords", () => {
    expect(interpretQuestion(g, "how do I?").kind).toBe("none");
  });

  it("offers what it did not pick", () => {
    const result = interpretQuestion(g, "How do I find the price of a product?");
    expect(result.alternatives).toContain("price");
  });

  it("works against a graph with no builtin vocabulary in use", () => {
    const result = interpretQuestion(customTypeGraph(), "Where is the cost figure?");
    expect(result.kind).toBe("field");
    expect(result.semanticName).toBe("cost-figure");
  });
});
