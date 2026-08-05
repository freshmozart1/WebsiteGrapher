import type { Page } from "playwright";

/**
 * The accessibility tree, when the browser will give us one.
 *
 * It is strictly a bonus: everything the analyzer decides is derived from the
 * normalized element list, and every code path works when this returns null.
 * `WGRAPH_NO_AX=1` forces null, which is how the test suite proves the
 * independence rather than asserting it.
 */
export interface AxNode {
  role: string;
  name: string;
  /** Index of the parent in the returned array, or -1 for a root. */
  parent: number;
}

export async function tryAccessibilityTree(page: Page): Promise<AxNode[] | null> {
  if (process.env.WGRAPH_NO_AX === "1") return null;

  try {
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send("Accessibility.enable");
      const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as {
        nodes: RawAxNode[];
      };
      return flatten(nodes);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    // Non-Chromium, CDP unavailable, or the call failed. Not a problem.
    return null;
  }
}

interface RawAxNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
  ignored?: boolean;
}

function flatten(raw: RawAxNode[]): AxNode[] {
  const index = new Map<string, number>();
  const kept = raw.filter((n) => !n.ignored);
  kept.forEach((n, i) => index.set(n.nodeId, i));

  const parentOf = new Map<string, string>();
  for (const node of kept) {
    for (const child of node.childIds ?? []) parentOf.set(child, node.nodeId);
  }

  return kept.map((node) => {
    const parentId = parentOf.get(node.nodeId);
    return {
      role: node.role?.value ?? "",
      name: node.name?.value ?? "",
      parent: parentId !== undefined ? (index.get(parentId) ?? -1) : -1,
    };
  });
}
