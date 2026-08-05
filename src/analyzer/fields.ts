import type { Page } from "playwright";

/**
 * Phase 7: where does the information sit on a detail page?
 *
 * This proposes positions and the *shape* of what lives there. It never
 * returns a value, and the suggested names are suggestions: the agent decides,
 * and registers a new field name when none of the existing ones fit. That is
 * how a rating or a stock status gets into the graph without the four builtin
 * names having to cover the whole web.
 */

export interface FieldCandidate {
  /** Structural selector — never a text or accessible-name hint. */
  css: string;
  /** What this probably is. "unknown" means the agent must decide. */
  suggestedName: string;
  valueShape: "currency" | "text" | "url" | "number" | null;
  reason: string;
  confidence: "high" | "medium" | "low";
}

/** Class and id fragments that name a thing rather than describe a layout. */
const NAME_HINTS: [RegExp, string, FieldCandidate["valueShape"]][] = [
  [/(^|[-_])price|cost|amount/, "price", "currency"],
  [/(^|[-_])(title|name|headline)/, "title", "text"],
  [/(desc|summary|blurb|about|synopsis)/, "description", "text"],
  [/(rating|stars|score)/, "rating", "number"],
  [/(avail|stock|inventory)/, "availability", "text"],
  [/(sku|isbn|barcode|product[-_]?id)/, "identifier", "text"],
  [/(author|brand|vendor|manufacturer|publisher)/, "brand", "text"],
  [/(^|[-_])(date|published|posted|updated)/, "date", "text"],
];

export async function findFieldCandidates(page: Page): Promise<FieldCandidate[]> {
  const raw = await page.evaluate(
    ({ hints }) => {
      function cssPathOf(el: Element): string {
        const id = el.getAttribute("id");
        if (id && document.querySelectorAll(`[id="${id}"]`).length === 1) {
          return `#${id}`;
        }
        const parts: string[] = [];
        let node: Element | null = el;
        while (node && node.nodeType === 1 && parts.length < 8) {
          const tag = node.tagName.toLowerCase();
          if (tag === "html" || tag === "body") break;
          const parent: Element | null = node.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const sameTag = Array.prototype.filter.call(
            parent.children,
            (c: Element) => c.tagName === node!.tagName,
          ) as Element[];
          parts.unshift(
            sameTag.length > 1
              ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
              : tag,
          );
          node = parent;
        }
        return parts.join(" > ");
      }

      /** Text belonging to this element rather than to its children. */
      function ownText(el: Element): string {
        let text = "";
        for (const node of Array.prototype.slice.call(el.childNodes) as Node[]) {
          if (node.nodeType === 3) text += node.textContent ?? "";
        }
        return text.replace(/\s+/g, " ").trim();
      }

      function visible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }

      const out: {
        css: string;
        suggestedName: string;
        valueShape: string | null;
        reason: string;
        confidence: string;
      }[] = [];
      const claimed = new Set<string>();

      const add = (
        el: Element,
        suggestedName: string,
        valueShape: string | null,
        reason: string,
        confidence: string,
      ) => {
        const css = cssPathOf(el);
        if (claimed.has(css)) return;
        claimed.add(css);
        out.push({ css, suggestedName, valueShape, reason, confidence });
      };

      // 1. A single h1 is the page's subject.
      const h1s = Array.prototype.slice.call(
        document.querySelectorAll("h1"),
      ) as Element[];
      if (h1s.length === 1 && h1s[0] && visible(h1s[0])) {
        add(h1s[0], "title", "text", "the page's only h1", "high");
      }

      // 2. Microdata says what things are without anyone reading a value.
      const ITEMPROP: Record<string, [string, string | null]> = {
        name: ["title", "text"],
        price: ["price", "currency"],
        description: ["description", "text"],
        image: ["image", "url"],
        ratingValue: ["rating", "number"],
        availability: ["availability", "text"],
        sku: ["identifier", "text"],
      };
      for (const el of Array.prototype.slice.call(
        document.querySelectorAll("[itemprop]"),
      ) as Element[]) {
        const prop = el.getAttribute("itemprop") ?? "";
        const mapped = ITEMPROP[prop];
        if (mapped && visible(el)) {
          add(el, mapped[0], mapped[1], `carries itemprop="${prop}"`, "high");
        }
      }

      // 3. A currency amount in an element's own text.
      const CURRENCY =
        /(^|\s)([£$€¥₹]\s?\d[\d.,]*|\d[\d.,]*\s?(?:EUR|USD|GBP|CHF|SEK|PLN))(\s|$)/;
      for (const el of Array.prototype.slice.call(
        document.querySelectorAll("*"),
      ) as Element[]) {
        if (!visible(el)) continue;
        const text = ownText(el);
        if (text.length > 0 && text.length < 40 && CURRENCY.test(text)) {
          add(el, "price", "currency", "its own text is a currency amount", "high");
        }
      }

      // 4. Class and id names that describe the thing rather than the layout.
      for (const el of Array.prototype.slice.call(
        document.querySelectorAll("*"),
      ) as Element[]) {
        if (!visible(el)) continue;
        const token = `${el.className || ""} ${el.id || ""}`.toLowerCase();
        if (!token.trim()) continue;
        for (const [pattern, name, shape] of hints) {
          if (!new RegExp(pattern).test(token)) continue;
          // `<div id="product_description"><h2>Product Description</h2></div>`
          // names the section; it is not where the description lives. An
          // element with no text of its own is a wrapper or a label, so let a
          // later rule find the element that actually holds the prose.
          if (shape === "text" && ownText(el).length === 0) break;
          add(el, name, shape, `its class or id contains "${name}"`, "medium");
          break;
        }
      }

      // 5. The biggest image is the one the page is about.
      const images = (
        Array.prototype.slice.call(document.querySelectorAll("img")) as HTMLImageElement[]
      )
        .filter(visible)
        .map((img) => ({ img, area: img.getBoundingClientRect().width * img.getBoundingClientRect().height }))
        .sort((a, b) => b.area - a.area);
      if (images[0] && images[0].area > 400) {
        add(images[0].img, "image", "url", "the largest visible image", "medium");
      }

      // 6. The longest run of prose.
      const paragraphs = (
        Array.prototype.slice.call(document.querySelectorAll("p")) as Element[]
      )
        .filter(visible)
        .map((p) => ({ p, length: ownText(p).length }))
        .sort((a, b) => b.length - a.length);
      if (paragraphs[0] && paragraphs[0].length > 60) {
        add(paragraphs[0].p, "description", "text", "the longest paragraph", "low");
      }

      return out;
    },
    { hints: NAME_HINTS.map(([re, name, shape]) => [re.source, name, shape] as const) },
  );

  return raw.map((c) => ({
    css: c.css,
    suggestedName: c.suggestedName,
    valueShape: c.valueShape as FieldCandidate["valueShape"],
    reason: c.reason,
    confidence: c.confidence as FieldCandidate["confidence"],
  }));
}

/**
 * A candidate is only worth storing if it holds on more than one item of the
 * same kind. Anything that resolves on one detail page but not another was a
 * property of that item, not of the page type.
 */
export function crossValidate(
  perPage: FieldCandidate[][],
): { candidate: FieldCandidate; verified: boolean }[] {
  const first = perPage[0] ?? [];
  const others = perPage.slice(1);

  return first.map((candidate) => ({
    candidate,
    verified:
      others.length > 0 &&
      others.every((page) => page.some((c) => c.css === candidate.css)),
  }));
}
