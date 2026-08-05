import type { Locator, Page } from "playwright";
import type { Action, LocatorDefinition } from "../graph/schema.js";
import { resolveUnique } from "../locator/resolve.js";
import type { NormalizedElement } from "./elements.js";
import { fingerprintPage, type PageFingerprint } from "./fingerprint.js";
import { classifyChange, type ChangeClassification } from "./diff.js";
import { assessRisk, type RiskTier } from "./risk.js";

/**
 * Save the state, interact, see what moved, put it back.
 *
 * A probe is atomic inside one command: nothing depends on browser state
 * surviving into the next CLI invocation.
 */

export interface ProbeOptions {
  /** The list to watch. Without it a probe can still detect navigation and
   *  layout changes, but not filtering. */
  containerCss?: string | null;
  /** Where to return to afterwards. Defaults to the URL at probe time. */
  restoreUrl?: string;
  settleMs?: number;
  /** Probe even if the risk tier says to ask first — set once approved. */
  approved?: boolean;
}

export interface ProbeResult {
  ref: string;
  description: string;
  /** The action that was performed, ready to become an ActionEdge. */
  action: Action;
  change: ChangeClassification;
  before: PageFingerprint;
  after: PageFingerprint;
  tier: RiskTier;
}

export class ProbeRefused extends Error {
  constructor(
    public readonly tier: RiskTier,
    public readonly reason: string,
  ) {
    super(`Refused to probe: ${reason}`);
    this.name = "ProbeRefused";
  }
}

const SETTLE_MS = 350;
const NETWORK_IDLE_MS = 2_000;
/** Typed into text inputs to see whether they narrow a list. Deliberately
 *  unpronounceable so a real catalogue never contains it. */
const NON_MATCHING_TOKEN = "zqxwvj";

export async function probeElement(
  page: Page,
  el: NormalizedElement,
  locator: LocatorDefinition,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const origin = new URL(page.url()).origin;
  const { tier, reason } = assessRisk(el, { origin });

  if (tier === "blocked") throw new ProbeRefused(tier, reason);
  if (tier === "confirm" && !options.approved) throw new ProbeRefused(tier, reason);

  const restoreUrl = options.restoreUrl ?? page.url();
  const container = options.containerCss ?? null;

  const before = await fingerprintPage(page, container);

  const target = await resolveUnique(page, locator);
  if (!target) {
    throw new Error(`Could not resolve ${describe(el)} on the page`);
  }

  const action = await interact(page, target, el);
  await settle(page, options.settleMs ?? SETTLE_MS);

  const after = await fingerprintPage(page, container);
  const change = classifyChange(before, after);

  await restore(page, restoreUrl, options.settleMs ?? SETTLE_MS);

  return {
    ref: el.ref,
    description: describe(el),
    action,
    change,
    before,
    after,
    tier,
  };
}

/** Perform the interaction that suits this control, and say which it was. */
async function interact(
  page: Page,
  target: Locator,
  el: NormalizedElement,
): Promise<Action> {
  if (el.tag === "select") {
    const values = await target.evaluate((node) =>
      Array.prototype.map.call(
        (node as HTMLSelectElement).options,
        (o: HTMLOptionElement) => o.value,
      ),
    );
    const current = await target.inputValue();
    const next = (values as string[]).find((v) => v !== current);
    if (next !== undefined) await target.selectOption(next);
    return "select";
  }

  if (el.type === "checkbox" || el.type === "radio") {
    await target.check();
    return "click";
  }

  if (el.tag === "input" || el.tag === "textarea") {
    // A token chosen to match nothing. A common letter is useless here: it
    // matches every item, and a working filter then looks like a no-op.
    // Enter is deliberately not pressed — that would submit the form.
    await target.fill(NON_MATCHING_TOKEN);
    return "fill";
  }

  await target.click({ timeout: 5_000 });
  return "click";
}

/** Wait long enough for whatever the interaction started to finish. */
async function settle(page: Page, ms: number): Promise<void> {
  await page
    .waitForLoadState("networkidle", { timeout: NETWORK_IDLE_MS })
    .catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function restore(page: Page, url: string, settleMs: number): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await settle(page, settleMs);
}

/**
 * Scroll to the bottom and see whether more items appear. The only way to tell
 * infinite scroll from a page that is simply long.
 */
export async function probeInfiniteScroll(
  page: Page,
  containerCss: string,
  options: { settleMs?: number } = {},
): Promise<ProbeResult | null> {
  const restoreUrl = page.url();
  const before = await fingerprintPage(page, containerCss);
  if (!before.list) return null;

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await settle(page, options.settleMs ?? SETTLE_MS);

  const after = await fingerprintPage(page, containerCss);
  const change = classifyChange(before, after);

  await restore(page, restoreUrl, options.settleMs ?? SETTLE_MS);

  return {
    ref: "scroll",
    description: "scrolling to the bottom of the page",
    action: "scroll",
    change,
    before,
    after,
    tier: "safe",
  };
}

export function describe(el: NormalizedElement): string {
  const name = el.text || el.ariaLabel || el.label || el.placeholder || el.name;
  const kind = el.role ?? el.tag;
  return name ? `the "${name}" ${kind}` : `an unlabelled ${kind}`;
}
