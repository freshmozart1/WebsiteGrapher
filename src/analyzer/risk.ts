import type { NormalizedElement } from "./elements.js";

/**
 * Phase 4 has to click things on a live site to find out what they do. This
 * decides what may be clicked without asking.
 *
 * The tiers are about *probing* — touching a control to see what happens.
 * A same-origin GET link is the safest thing on the web and is probed freely;
 * what makes something dangerous is that its label describes an action with
 * consequences, or that it posts.
 */
export type RiskTier = "safe" | "confirm" | "blocked";

export interface RiskAssessment {
  tier: RiskTier;
  /** Why, in a form that can be shown to the user at the approval checkpoint. */
  reason: string;
}

/** Labels that describe an action with consequences. Never probed. */
const DESTRUCTIVE = [
  "buy", "purchase", "order now", "place order", "checkout", "check out",
  "pay", "payment", "add to cart", "add to basket", "delete", "remove",
  "destroy", "log out", "logout", "sign out", "unsubscribe", "subscribe",
  "cancel account", "close account", "confirm order", "submit order",
  "book now", "reserve", "donate", "send message", "post comment",
];

/** Labels that describe looking at things differently. Probed freely. */
const LIST_CONTROL = [
  "filter", "sort", "apply", "show", "view", "display", "more", "less",
  "next", "previous", "prev", "load", "page", "search", "refine", "clear",
  "reset", "all", "expand", "collapse",
];

const DANGEROUS_INPUT_TYPES = ["password", "email", "tel", "file", "hidden"];

/**
 * Roles that describe what a region *is*, not something you can operate.
 * They reach the element list because they carry a `role` attribute — a
 * `<div role="alert">` holding a site notice, for instance — but clicking one
 * is meaningless, and offering it for approval is just noise.
 */
const NON_INTERACTIVE_ROLES = new Set([
  "alert", "status", "log", "marquee", "timer", "region", "banner",
  "contentinfo", "main", "navigation", "complementary", "search", "form",
  "article", "document", "heading", "img", "presentation", "none", "list",
  "listitem", "definition", "note", "group", "separator", "tooltip", "figure",
  "table", "row", "cell", "columnheader", "rowheader", "rowgroup", "term",
  "paragraph", "caption", "directory", "feed", "math", "toolbar",
]);

const SENSITIVE_NAMES = [
  "password", "passwd", "card", "cardnumber", "cvv", "cvc", "iban",
  "account", "ssn", "token", "secret", "otp",
];

export function assessRisk(
  el: NormalizedElement,
  context: { origin: string },
): RiskAssessment {
  const label = labelOf(el);

  if (el.disabled) {
    return { tier: "blocked", reason: "the control is disabled" };
  }

  if (!el.href && el.role && NON_INTERACTIVE_ROLES.has(el.role)) {
    return {
      tier: "blocked",
      reason: `role="${el.role}" describes a region, not something you can operate`,
    };
  }

  const destructive = DESTRUCTIVE.find((word) => label.includes(word));
  if (destructive) {
    return {
      tier: "blocked",
      reason: `its label contains "${destructive}", which describes an action with consequences`,
    };
  }

  if (el.form?.method === "post") {
    return {
      tier: "blocked",
      reason: "it sits inside a form that POSTs, so touching it could submit real data",
    };
  }

  if (el.tag === "input" && el.type && DANGEROUS_INPUT_TYPES.includes(el.type)) {
    return {
      tier: "blocked",
      reason: `it is a ${el.type} input, which is never filled during learning`,
    };
  }

  if (el.name && SENSITIVE_NAMES.some((n) => el.name!.toLowerCase().includes(n))) {
    return {
      tier: "blocked",
      reason: `its name "${el.name}" suggests credentials or payment details`,
    };
  }

  if (el.href) {
    const target = safeUrl(el.href);
    if (!target) {
      return { tier: "blocked", reason: "its href could not be parsed" };
    }
    if (target.origin !== context.origin) {
      return {
        tier: "blocked",
        reason: `it leaves this site for ${target.origin}`,
      };
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return { tier: "blocked", reason: `it uses the ${target.protocol} scheme` };
    }
    return {
      tier: "safe",
      reason: "a same-origin link: following it only navigates",
    };
  }

  // Controls that change what you are looking at, not what exists.
  if (
    el.role === "checkbox" ||
    el.role === "radio" ||
    el.role === "combobox" ||
    el.role === "searchbox" ||
    el.role === "tab" ||
    el.tag === "select" ||
    el.type === "search" ||
    el.type === "checkbox" ||
    el.type === "radio"
  ) {
    return {
      tier: "safe",
      reason: `a ${el.role ?? el.type ?? el.tag} control, which selects rather than commits`,
    };
  }

  if (LIST_CONTROL.some((word) => label.includes(word))) {
    return {
      tier: "safe",
      reason: "its label describes changing how the list is shown",
    };
  }

  if (el.type === "submit") {
    return {
      tier: "confirm",
      reason: `a submit control labelled "${el.text || "(no label)"}" inside a ${el.form?.method ?? "get"} form`,
    };
  }

  if (el.role === "button" || el.tag === "button") {
    const where = el.form ? ` inside a ${el.form.method} form` : "";
    return {
      tier: "confirm",
      reason: `a button labelled "${el.text || "(no label)"}"${where}, whose effect is not obvious from its label`,
    };
  }

  if (el.tag === "textarea" || el.tag === "input") {
    return {
      tier: "confirm",
      reason: `a ${el.type ?? "text"} input whose effect on the list is not obvious`,
    };
  }

  return {
    tier: "confirm",
    reason: `a ${el.tag} element with no clear role`,
  };
}

function labelOf(el: NormalizedElement): string {
  return [el.text, el.ariaLabel, el.label, el.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** Split a page's elements into what may be probed now, what needs asking,
 *  and what is off limits. */
export function tierElements(
  elements: NormalizedElement[],
  context: { origin: string },
): { safe: NormalizedElement[]; confirm: NormalizedElement[]; blocked: NormalizedElement[] } {
  const safe: NormalizedElement[] = [];
  const confirm: NormalizedElement[] = [];
  const blocked: NormalizedElement[] = [];

  for (const el of elements) {
    if (!el.visible) continue;
    const { tier } = assessRisk(el, context);
    if (tier === "safe") safe.push(el);
    else if (tier === "confirm") confirm.push(el);
    else blocked.push(el);
  }
  return { safe, confirm, blocked };
}
