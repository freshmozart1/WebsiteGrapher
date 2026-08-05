import type { Page } from "playwright";

/**
 * A normalized view of every interactive element on a page.
 *
 * This is the only thing the rest of the analyzer reads. It is produced by one
 * `page.evaluate`, contains no page prose beyond control labels, and never
 * depends on the accessibility tree.
 */
export interface NormalizedElement {
  /** Stable within one observation, so other commands can refer back to it. */
  ref: string;
  tag: string;
  /** Explicit `role`, else the implicit role for the tag. */
  role: string | null;
  /** The control's own label, capped. Not page content. */
  text: string;
  href: string | null;
  label: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  testId: string | null;
  id: string | null;
  name: string | null;
  type: string | null;
  disabled: boolean;
  visible: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  /** Unique CSS selector, the locator hint of last resort. */
  cssPath: string;
  /** Set when the element sits inside a form — the single most important
   *  signal for risk tiering. */
  form: { method: string; action: string } | null;
  /** Nearest landmark ancestor (nav, header, footer, main, aside). Tells a
   *  site's own map apart from its small print. */
  landmark: string | null;
  classes: string[];
}

/** Guards against pathological pages; 400 controls is far past any real page. */
const MAX_ELEMENTS = 400;
const MAX_TEXT = 80;

export async function extractElements(page: Page): Promise<NormalizedElement[]> {
  return await page.evaluate(
    ({ maxElements, maxText }) => {
      const SELECTOR =
        "a[href], button, input, select, textarea, summary, label, [role], [onclick], [tabindex]";

      const IMPLICIT_ROLE: Record<string, string> = {
        a: "link",
        button: "button",
        select: "combobox",
        textarea: "textbox",
        summary: "button",
        h1: "heading",
        h2: "heading",
        h3: "heading",
      };

      const INPUT_ROLE: Record<string, string> = {
        button: "button",
        submit: "button",
        reset: "button",
        checkbox: "checkbox",
        radio: "radio",
        range: "slider",
        search: "searchbox",
        email: "textbox",
        tel: "textbox",
        text: "textbox",
        url: "textbox",
        number: "spinbutton",
      };

      function roleOf(el: Element): string | null {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (tag === "input") {
          const type = (el as HTMLInputElement).type.toLowerCase();
          return INPUT_ROLE[type] ?? "textbox";
        }
        return IMPLICIT_ROLE[tag] ?? null;
      }

      function isVisible(el: Element): boolean {
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return false;
        }
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      }

      function labelFor(el: Element): string | null {
        const id = el.getAttribute("id");
        if (id) {
          const escaped =
            typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
          const explicit = document.querySelector(`label[for="${escaped}"]`);
          if (explicit?.textContent) return explicit.textContent.trim().slice(0, maxText);
        }
        const wrapping = el.closest("label");
        if (wrapping?.textContent) return wrapping.textContent.trim().slice(0, maxText);
        return null;
      }

      /** Prefer id, then a test id, then a positional path. */
      function cssPathOf(el: Element): string {
        const id = el.getAttribute("id");
        if (id && document.querySelectorAll(`[id="${id}"]`).length === 1) {
          return `#${id}`;
        }
        const testId = el.getAttribute("data-testid");
        if (testId) return `[data-testid="${testId}"]`;

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

      function landmarkOf(el: Element): string | null {
        const TAGS = ["nav", "header", "footer", "main", "aside"];
        const ROLES: Record<string, string> = {
          navigation: "nav",
          banner: "header",
          contentinfo: "footer",
          main: "main",
          complementary: "aside",
        };
        let node: Element | null = el;
        while (node) {
          const tag = node.tagName.toLowerCase();
          if (TAGS.indexOf(tag) !== -1) return tag;
          const role = node.getAttribute("role");
          if (role && ROLES[role]) return ROLES[role]!;
          node = node.parentElement;
        }
        return null;
      }

      function formOf(el: Element): { method: string; action: string } | null {
        const form = el.closest("form");
        if (!form) return null;
        return {
          method: (form.getAttribute("method") ?? "get").toLowerCase(),
          action: form.getAttribute("action") ?? "",
        };
      }

      const seen = new Set<Element>();
      const out: NormalizedElement[] = [];

      const candidates = Array.prototype.slice.call(
        document.querySelectorAll(SELECTOR),
      ) as Element[];

      for (const el of candidates) {
        if (out.length >= maxElements) break;
        if (seen.has(el)) continue;
        seen.add(el);

        const tag = el.tagName.toLowerCase();
        if (tag === "input" && (el as HTMLInputElement).type === "hidden") continue;

        const box = el.getBoundingClientRect();
        out.push({
          ref: `e${out.length + 1}`,
          tag,
          role: roleOf(el),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, maxText),
          href: el instanceof HTMLAnchorElement ? el.href : null,
          label: labelFor(el),
          placeholder: el.getAttribute("placeholder"),
          ariaLabel: el.getAttribute("aria-label"),
          testId: el.getAttribute("data-testid"),
          id: el.getAttribute("id"),
          name: el.getAttribute("name"),
          type: el.getAttribute("type"),
          disabled:
            el.hasAttribute("disabled") ||
            el.getAttribute("aria-disabled") === "true",
          visible: isVisible(el),
          boundingBox:
            box.width > 0 || box.height > 0
              ? { x: box.x, y: box.y, width: box.width, height: box.height }
              : null,
          cssPath: cssPathOf(el),
          form: formOf(el),
          landmark: landmarkOf(el),
          classes: Array.prototype.slice.call(el.classList) as string[],
        });
      }

      return out;
    },
    { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT },
  );
}

/** The accessible name a role-based locator would match. */
export function accessibleName(el: NormalizedElement): string | null {
  return el.ariaLabel ?? el.label ?? (el.text.length > 0 ? el.text : null);
}
