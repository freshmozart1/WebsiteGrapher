import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GraphNotFoundError,
  GraphValidationError,
  domainKey,
  graphExists,
  listGraphs,
  loadGraph,
  loadGraphOrNull,
  originOf,
  saveGraph,
  withGraph,
} from "../../src/graph/store.js";
import { emptyGraph } from "../../src/graph/schema.js";
import { bookshopGraph } from "../helpers/graphs.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wgraph-store-"));
  process.env.WGRAPH_HOME = home;
});

afterEach(async () => {
  delete process.env.WGRAPH_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("domainKey", () => {
  it("reduces a URL to its host", () => {
    expect(domainKey("https://books.toscrape.com/catalogue/x/index.html")).toBe(
      "books.toscrape.com",
    );
  });

  it("treats www as the same site, so knowledge is not split in two", () => {
    expect(domainKey("https://www.example.com")).toBe("example.com");
    expect(domainKey("example.com")).toBe("example.com");
    expect(domainKey("HTTPS://WWW.Example.COM/a?b=1")).toBe("example.com");
  });

  it("keeps distinct subdomains distinct", () => {
    expect(domainKey("https://shop.example.com")).toBe("shop.example.com");
  });
});

describe("originOf", () => {
  it("drops path and query", () => {
    expect(originOf("https://example.com/a/b?c=1#d")).toBe("https://example.com");
  });

  it("assumes https when no scheme is given", () => {
    expect(originOf("example.com")).toBe("https://example.com");
  });
});

describe("save and load", () => {
  it("round-trips a graph unchanged", async () => {
    const original = bookshopGraph();
    await saveGraph("books.toscrape.com", original);
    expect(graphExists("books.toscrape.com")).toBe(true);
    expect(await loadGraph("books.toscrape.com")).toEqual(original);
  });

  it("writes readable JSON a human can inspect and hand-edit", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    const raw = await readFile(join(home, "books.toscrape.com.json"), "utf8");
    expect(raw).toContain('\n  "pages": [');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("refuses to write a graph that would be invalid", async () => {
    const g = bookshopGraph();
    g.fields[0]!.semanticName = "never-registered";
    await expect(saveGraph("books.toscrape.com", g)).rejects.toThrow(
      GraphValidationError,
    );
    expect(graphExists("books.toscrape.com")).toBe(false);
  });

  it("reports a missing graph with the command that would create it", async () => {
    await expect(loadGraph("nowhere.example")).rejects.toThrow(GraphNotFoundError);
    await expect(loadGraph("nowhere.example")).rejects.toThrow(/wgraph analyze/);
    expect(await loadGraphOrNull("nowhere.example")).toBeNull();
  });

  it("rejects a graph written by a newer wgraph", async () => {
    const g = { ...bookshopGraph(), schemaVersion: 99 };
    await saveGraph("books.toscrape.com", bookshopGraph());
    await rm(join(home, "books.toscrape.com.json"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(home, "books.toscrape.com.json"),
      JSON.stringify(g),
      "utf8",
    );
    await expect(loadGraph("books.toscrape.com")).rejects.toThrow(/newer wgraph/);
  });

  it("lists known sites", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await saveGraph("example.com", emptyGraph("https://example.com"));
    expect(await listGraphs()).toEqual(["books.toscrape.com", "example.com"]);
  });

  it("lists nothing before any site is learned", async () => {
    await rm(home, { recursive: true, force: true });
    expect(await listGraphs()).toEqual([]);
  });
});

describe("withGraph", () => {
  it("creates a graph on first use when an origin is supplied", async () => {
    const { graph } = await withGraph(
      "example.com",
      (g) => {
        g.entryPageId = "";
        return null;
      },
      { createOrigin: "https://example.com" },
    );
    expect(graph.origin).toBe("https://example.com");
    expect(await loadGraphOrNull("example.com")).not.toBeNull();
  });

  it("refuses to invent a graph when no origin is supplied", async () => {
    await expect(withGraph("example.com", () => null)).rejects.toThrow(
      GraphNotFoundError,
    );
  });

  it("persists the mutation", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await withGraph("books.toscrape.com", (g) => {
      g.entryPageId = "page-overview";
    });
    expect((await loadGraph("books.toscrape.com")).entryPageId).toBe("page-overview");
  });

  it("leaves the file untouched when the mutation would break the graph", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await expect(
      withGraph("books.toscrape.com", (g) => {
        g.entryPageId = "page-does-not-exist";
      }),
    ).rejects.toThrow(GraphValidationError);
    expect((await loadGraph("books.toscrape.com")).entryPageId).toBe("page-home");
  });

  it("releases the lock even when the mutation throws", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await expect(
      withGraph("books.toscrape.com", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A second call would time out on a leaked lock.
    await expect(
      withGraph("books.toscrape.com", (g) => g.pages.length),
    ).resolves.toMatchObject({ result: 3 });
  });

  it("serialises concurrent writers instead of dropping one", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await Promise.all(
      ["a", "b", "c"].map((name) =>
        withGraph("books.toscrape.com", (g) => {
          g.vocabulary.fieldNames.push({
            name: `custom-${name}`,
            description: `field ${name}`,
            builtin: false,
          });
        }),
      ),
    );
    const names = (await loadGraph("books.toscrape.com")).vocabulary.fieldNames.map(
      (e) => e.name,
    );
    expect(names).toContain("custom-a");
    expect(names).toContain("custom-b");
    expect(names).toContain("custom-c");
  });
});
