import type { NormalizedElement } from './elements.js';

/**
 * Phase 4 has to click things on a live site to find out what they do. This
 * decides what may be clicked without asking.
 *
 * The tiers are about *probing* — touching a control to see what happens.
 * A same-origin GET link is the safest thing on the web and is probed freely;
 * what makes something dangerous is that its label describes an action with
 * consequences, or that it posts.
 */
export type RiskTier = 'safe' | 'confirm' | 'blocked';

export interface RiskAssessment {
    tier: RiskTier;
    /** Why, in a form that can be shown to the user at the approval checkpoint. */
    reason: string;
}

/** Labels that describe an action with consequences. Never probed. */
const DESTRUCTIVE = [
    'buy',
    'purchase',
    'order now',
    'place order',
    'checkout',
    'check out',
    'pay',
    'payment',
    'add to cart',
    'add to basket',
    'delete',
    'remove',
    'destroy',
    'log out',
    'logout',
    'sign out',
    'unsubscribe',
    'subscribe',
    'cancel account',
    'close account',
    'confirm order',
    'submit order',
    'book now',
    'reserve',
    'donate',
    'send message',
    'post comment',
];

/** Labels that describe looking at things differently. Probed freely. */
const LIST_CONTROL = [
    'filter',
    'sort',
    'apply',
    'show',
    'view',
    'display',
    'more',
    'less',
    'next',
    'previous',
    'prev',
    'load',
    'page',
    'search',
    'refine',
    'clear',
    'reset',
    'all',
    'expand',
    'collapse',
];

const DANGEROUS_INPUT_TYPES = ['password', 'email', 'tel', 'file', 'hidden'];

/**
 * Roles that describe what a region *is*, not something you can operate.
 * They reach the element list because they carry a `role` attribute — a
 * `<div role="alert">` holding a site notice, for instance — but clicking one
 * is meaningless, and offering it for approval is just noise.
 */
const NON_INTERACTIVE_ROLES = new Set([
    'alert',
    'status',
    'log',
    'marquee',
    'timer',
    'region',
    'banner',
    'contentinfo',
    'main',
    'navigation',
    'complementary',
    'search',
    'form',
    'article',
    'document',
    'heading',
    'img',
    'presentation',
    'none',
    'list',
    'listitem',
    'definition',
    'note',
    'group',
    'separator',
    'tooltip',
    'figure',
    'table',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'rowgroup',
    'term',
    'paragraph',
    'caption',
    'directory',
    'feed',
    'math',
    'toolbar',
]);

const SENSITIVE_NAMES = [
    'password',
    'passwd',
    'card',
    'cardnumber',
    'cvv',
    'cvc',
    'iban',
    'account',
    'ssn',
    'token',
    'secret',
    'otp',
];

/** One rule in the chain below. Returns null when it does not apply, so the
 *  next rule gets a turn. */
type RiskRule = (
    el: NormalizedElement,
    label: string,
    context: { origin: string },
) => RiskAssessment | null;

const disabledRule: RiskRule = (el) =>
    el.disabled ? { tier: 'blocked', reason: 'the control is disabled' } : null;

const nonInteractiveRoleRule: RiskRule = (el) =>
    !el.href && el.role && NON_INTERACTIVE_ROLES.has(el.role)
        ? {
              tier: 'blocked',
              reason: `role="${el.role}" describes a region, not something you can operate`,
          }
        : null;

const destructiveLabelRule: RiskRule = (_el, label) => {
    const destructive = DESTRUCTIVE.find((word) => label.includes(word));
    return destructive
        ? {
              tier: 'blocked',
              reason: `its label contains "${destructive}", which describes an action with consequences`,
          }
        : null;
};

const postFormRule: RiskRule = (el) =>
    el.form?.method === 'post'
        ? {
              tier: 'blocked',
              reason: 'it sits inside a form that POSTs, so touching it could submit real data',
          }
        : null;

const dangerousInputTypeRule: RiskRule = (el) =>
    el.tag === 'input' && el.type && DANGEROUS_INPUT_TYPES.includes(el.type)
        ? {
              tier: 'blocked',
              reason: `it is a ${el.type} input, which is never filled during learning`,
          }
        : null;

const sensitiveNameRule: RiskRule = (el) =>
    el.name && SENSITIVE_NAMES.some((n) => el.name!.toLowerCase().includes(n))
        ? {
              tier: 'blocked',
              reason: `its name "${el.name}" suggests credentials or payment details`,
          }
        : null;

const hrefRule: RiskRule = (el, _label, context) => {
    if (!el.href) return null;

    const target = safeUrl(el.href);
    if (!target) {
        return { tier: 'blocked', reason: 'its href could not be parsed' };
    }
    if (target.origin !== context.origin) {
        return {
            tier: 'blocked',
            reason: `it leaves this site for ${target.origin}`,
        };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return {
            tier: 'blocked',
            reason: `it uses the ${target.protocol} scheme`,
        };
    }
    return {
        tier: 'safe',
        reason: 'a same-origin link: following it only navigates',
    };
};

const SELECTION_ROLES = new Set([
    'checkbox',
    'radio',
    'combobox',
    'searchbox',
    'tab',
]);
const SELECTION_TYPES = new Set(['search', 'checkbox', 'radio']);

/** Controls that change what you are looking at, not what exists. */
const selectionControlRule: RiskRule = (el) => {
    const isSelectionControl =
        (el.role !== null && SELECTION_ROLES.has(el.role)) ||
        el.tag === 'select' ||
        (el.type !== null && SELECTION_TYPES.has(el.type));
    return isSelectionControl
        ? {
              tier: 'safe',
              reason: `a ${el.role ?? el.type ?? el.tag} control, which selects rather than commits`,
          }
        : null;
};

const listControlLabelRule: RiskRule = (_el, label) =>
    LIST_CONTROL.some((word) => label.includes(word))
        ? {
              tier: 'safe',
              reason: 'its label describes changing how the list is shown',
          }
        : null;

const submitRule: RiskRule = (el) =>
    el.type === 'submit'
        ? {
              tier: 'confirm',
              reason: `a submit control labelled "${el.text || '(no label)'}" inside a ${el.form?.method ?? 'get'} form`,
          }
        : null;

const buttonRule: RiskRule = (el) => {
    if (el.role !== 'button' && el.tag !== 'button') return null;
    const where = el.form ? ` inside a ${el.form.method} form` : '';
    return {
        tier: 'confirm',
        reason: `a button labelled "${el.text || '(no label)'}"${where}, whose effect is not obvious from its label`,
    };
};

const textInputRule: RiskRule = (el) =>
    el.tag === 'textarea' || el.tag === 'input'
        ? {
              tier: 'confirm',
              reason: `a ${el.type ?? 'text'} input whose effect on the list is not obvious`,
          }
        : null;

/** Checked in order; the first rule that applies decides the tier. */
const RISK_RULES: RiskRule[] = [
    disabledRule,
    nonInteractiveRoleRule,
    destructiveLabelRule,
    postFormRule,
    dangerousInputTypeRule,
    sensitiveNameRule,
    hrefRule,
    selectionControlRule,
    listControlLabelRule,
    submitRule,
    buttonRule,
    textInputRule,
];

export function assessRisk(
    el: NormalizedElement,
    context: { origin: string },
): RiskAssessment {
    const label = labelOf(el);
    for (const rule of RISK_RULES) {
        const result = rule(el, label, context);
        if (result) return result;
    }
    return {
        tier: 'confirm',
        reason: `a ${el.tag} element with no clear role`,
    };
}

function labelOf(el: NormalizedElement): string {
    return [el.text, el.ariaLabel, el.label, el.name]
        .filter(Boolean)
        .join(' ')
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
): {
    safe: NormalizedElement[];
    confirm: NormalizedElement[];
    blocked: NormalizedElement[];
} {
    const safe: NormalizedElement[] = [];
    const confirm: NormalizedElement[] = [];
    const blocked: NormalizedElement[] = [];

    for (const el of elements) {
        if (!el.visible) continue;
        const { tier } = assessRisk(el, context);
        if (tier === 'safe') safe.push(el);
        else if (tier === 'confirm') confirm.push(el);
        else blocked.push(el);
    }
    return { safe, confirm, blocked };
}
