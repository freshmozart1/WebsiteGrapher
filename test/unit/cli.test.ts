import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { graphCommand } from "../../src/cli/commands/graph.js";
import { askCommand, planCommand } from "../../src/cli/commands/plan.js";
import { EXIT, UsageError } from "../../src/cli/exit.js";
import { saveGraph } from "../../src/graph/store.js";
import { bookshopGraph } from "../helpers/graphs.js";

let home: string;
let out: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wgraph-cli-"));
  process.env.WGRAPH_HOME = home;
  out = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out.push(args.join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.WGRAPH_HOME;
  await rm(home, { recursive: true, force: true });
});

const printed = () => out.join("\n");

describe("wgraph ask", () => {
  beforeEach(async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
  });

  it("answers the price question from the stored graph", async () => {
    const code = await askCommand([
      "books.toscrape.com",
      "How do I find the price of a product?",
    ]);
    expect(code).toBe(EXIT.OK);
    expect(printed()).toContain('1. Click the "Books" link to reach the overview page');
    expect(printed()).toContain("2. Click an item in the list to reach the detail page");
    expect(printed()).toContain("3. The price is on the detail page");
  });

  it("answers the navigation question", async () => {
    const code = await askCommand([
      "books.toscrape.com",
      "What steps are necessary to view the product details?",
    ]);
    expect(code).toBe(EXIT.OK);
    expect(printed()).toContain("That is the detail page");
  });

  it("answers a question about a custom field name", async () => {
    await askCommand(["books.toscrape.com", "Where can I see the star rating?"]);
    expect(printed()).toContain("The star-rating is on the detail page");
  });

  it("accepts a full URL as the domain", async () => {
    const code = await askCommand([
      "https://books.toscrape.com/catalogue/whatever/index.html",
      "where is the price",
    ]);
    expect(code).toBe(EXIT.OK);
  });

  it("reports a gap instead of guessing when nothing matches", async () => {
    const code = await askCommand([
      "books.toscrape.com",
      "What is the delivery lead time?",
    ]);
    expect(code).toBe(EXIT.GAP);
    expect(printed()).toMatch(/Could not tell what/);
  });

  it("emits JSON when asked", async () => {
    await askCommand(["books.toscrape.com", "where is the price", "--json"]);
    const parsed = JSON.parse(printed());
    expect(parsed.ok).toBe(true);
    expect(parsed.field.semanticName).toBe("price");
  });

  it("requires a question", async () => {
    await expect(askCommand(["books.toscrape.com"])).rejects.toThrow(UsageError);
  });
});

describe("wgraph plan", () => {
  beforeEach(async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
  });

  it("routes to an explicitly named field", async () => {
    const code = await planCommand(["books.toscrape.com", "--field", "availability"]);
    expect(code).toBe(EXIT.OK);
    expect(printed()).toContain("The availability is on the detail page");
  });

  it("returns a gap code for a field the site does not have", async () => {
    expect(
      await planCommand(["books.toscrape.com", "--field", "shipping-weight"]),
    ).toBe(EXIT.GAP);
  });

  it("insists on exactly one target", async () => {
    await expect(planCommand(["books.toscrape.com"])).rejects.toThrow(UsageError);
    await expect(
      planCommand(["books.toscrape.com", "--field", "price", "--page", "page-home"]),
    ).rejects.toThrow(UsageError);
  });
});

describe("wgraph graph", () => {
  it("lists nothing before anything is learned", async () => {
    expect(await graphCommand(["list"])).toBe(EXIT.OK);
    expect(printed()).toMatch(/No sites learned yet/);
  });

  it("applies a patch from a file and validates the result", async () => {
    const patch = join(home, "patch.json");
    await writeFile(
      patch,
      JSON.stringify({
        pages: [
          { id: "page-home", type: "home", urlPattern: "/", entry: true },
          { id: "page-list", type: "overview", urlPattern: "/items" },
        ],
        edges: [
          {
            sourceNode: "page-home",
            targetNode: "page-list",
            action: "click",
            locator: { role: "link", name: "Items" },
          },
        ],
      }),
      "utf8",
    );

    expect(await graphCommand(["apply", "shop.example", "--file", patch])).toBe(EXIT.OK);
    expect(await graphCommand(["validate", "shop.example"])).toBe(EXIT.OK);
    expect(printed()).toContain("2 pages");
  });

  it("registers a custom type and then accepts a node using it", async () => {
    await graphCommand([
      "apply",
      "shop.example",
      "--patch",
      JSON.stringify({
        pages: [{ id: "page-home", type: "home", urlPattern: "/", entry: true }],
      }),
    ]);
    expect(
      await graphCommand([
        "add-type",
        "shop.example",
        "page",
        "checkout-step",
        "--description",
        "One step of a multi-step purchase flow",
      ]),
    ).toBe(EXIT.OK);
    expect(printed()).toContain('Registered page type "checkout-step"');

    expect(
      await graphCommand([
        "apply",
        "shop.example",
        "--patch",
        JSON.stringify({
          pages: [{ id: "page-pay", type: "checkout-step", urlPattern: "/pay" }],
        }),
      ]),
    ).toBe(EXIT.OK);
  });

  it("refuses to register a type without a description", async () => {
    await graphCommand([
      "apply",
      "shop.example",
      "--patch",
      JSON.stringify({
        pages: [{ id: "page-home", type: "home", urlPattern: "/", entry: true }],
      }),
    ]);
    await expect(
      graphCommand(["add-type", "shop.example", "page", "checkout-step"]),
    ).rejects.toThrow(/--description is required/);
  });

  it("shows the vocabulary with usage counts", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await graphCommand(["show", "books.toscrape.com", "--vocabulary"]);
    expect(printed()).toMatch(/custom\s+star-rating\s+used\s+1x/);
    expect(printed()).toMatch(/builtin\s+price\s+used\s+1x/);
  });

  it("marks the entry page when showing a graph", async () => {
    await saveGraph("books.toscrape.com", bookshopGraph());
    await graphCommand(["show", "books.toscrape.com"]);
    expect(printed()).toMatch(/page-home.*<- entry/);
  });

  it("rejects an unknown subcommand", async () => {
    await expect(graphCommand(["frobnicate"])).rejects.toThrow(UsageError);
  });
});
