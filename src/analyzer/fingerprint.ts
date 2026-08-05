import type { Page } from "playwright";

/**
 * Fingerprints are how a probe tells whether an interaction changed the list.
 *
 * Item text is hashed inside the page and only the hash crosses back into
 * Node. That is deliberate: the guarantee that no page content is stored holds
 * structurally, not because every caller remembered to be careful.
 */

export interface ListFingerprint {
  containerCss: string;
  itemCount: number;
  /** One hash per item, in document order. Never the text itself. */
  itemHashes: string[];
  /** Structural signature of the container: tags and classes only. */
  signature: string;
}

export interface PageFingerprint {
  url: string;
  title: string;
  list: ListFingerprint | null;
  /** Hash of the tag/class skeleton of the whole document. */
  domHash: string;
  interactiveCount: number;
}

export async function fingerprintPage(
  page: Page,
  containerCss?: string | null,
): Promise<PageFingerprint> {
  return await page.evaluate((container) => {
    /** FNV-1a. Small, dependency-free, and good enough to detect change. */
    function hash(input: string): string {
      let h = 0x811c9dc5;
      for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    }

    function normalize(text: string): string {
      return text.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function skeleton(root: Element): string {
      const parts: string[] = [];
      const walk = (el: Element, depth: number) => {
        if (depth > 12) return;
        const classes = Array.prototype.slice.call(el.classList).sort().join(".");
        parts.push(`${el.tagName.toLowerCase()}.${classes}`);
        for (const child of Array.prototype.slice.call(el.children) as Element[]) {
          walk(child, depth + 1);
        }
      };
      walk(root, 0);
      return hash(parts.join(">"));
    }

    let list: ListFingerprint | null = null;
    if (container) {
      const el = document.querySelector(container);
      if (el) {
        const items = Array.prototype.slice.call(el.children) as Element[];
        const visible = items.filter((item) => {
          const style = window.getComputedStyle(item);
          return style.display !== "none" && style.visibility !== "hidden";
        });
        list = {
          containerCss: container,
          itemCount: visible.length,
          itemHashes: visible.map((item) => hash(normalize(item.textContent ?? ""))),
          signature: skeleton(el),
        };
      }
    }

    return {
      url: location.href,
      title: document.title,
      list,
      domHash: skeleton(document.body),
      interactiveCount: document.querySelectorAll(
        "a[href], button, input, select, textarea",
      ).length,
    };
  }, containerCss ?? null);
}
