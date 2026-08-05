import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/**
 * These helpers used to be copy-pasted into each analyzer's `page.evaluate`,
 * because a serialized callback cannot close over module scope. The copies
 * drifted — `elements.ts` grew a `data-testid` shortcut the other two never
 * got — which is exactly the failure this guard exists to catch. If a helper
 * reappears inside an analyzer, add it to `src/browser/dom-helpers.ts` instead.
 */
const ANALYZERS = ["analyzer/elements.ts", "analyzer/structure.ts", "analyzer/fields.ts"];
const SHARED = ["cssPathOf", "relativePath", "landmarkOf", "segmentFor"];

describe("the in-page DOM helpers have one definition", () => {
  it.each(ANALYZERS)("%s defines none of them itself", async (file) => {
    const source = await readFile(join(SRC, file), "utf8");
    for (const name of SHARED) {
      expect(source, `${file} redefines ${name}`).not.toMatch(
        new RegExp(`function\\s+${name}\\b`),
      );
    }
  });

  it("defines each of them exactly once, in dom-helpers.ts", async () => {
    const source = await readFile(join(SRC, "browser/dom-helpers.ts"), "utf8");
    for (const name of SHARED) {
      const definitions = source.match(new RegExp(`function\\s+${name}\\b`, "g")) ?? [];
      expect(definitions, `${name} in dom-helpers.ts`).toHaveLength(1);
    }
  });

  it("is installed on the one place that builds a browser context", async () => {
    const source = await readFile(join(SRC, "browser/session.ts"), "utf8");
    expect(source).toContain("addDomHelpers(context)");
  });
});
