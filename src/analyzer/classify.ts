import type { PageSignals } from './observe.js';

/**
 * A first guess at what kind of page this is, from the counted signals alone.
 *
 * This exists so the CLI produces a usable graph on its own. It is explicitly
 * a draft: the agent reads the same observation and overrules this whenever
 * the page does not fit, including by registering a page type that does not
 * exist yet. Confidence is reported so a weak guess is visible as one.
 */

export interface Classification {
    type: string;
    confidence: 'high' | 'medium' | 'low';
    reasons: string[];
}

/** One classification guess. Returns null when it does not apply, so the
 *  next rule in `CLASSIFY_RULES` gets a turn. */
type ClassifyRule = (
    signals: PageSignals,
    hasCluster: boolean,
) => Classification | null;

const postFormRule: ClassifyRule = (signals) =>
    signals.postFormCount >= 1 && signals.inputCount >= 2
        ? {
              type: 'form',
              confidence: 'high',
              reasons: [
                  `${signals.postFormCount} visible POST form(s) with ${signals.inputCount} visible input(s)`,
              ],
          }
        : null;

/** Checked before the list rule: a detail page usually carries a repeating
 *  specification table, and that repeats every bit as convincingly as a
 *  product grid. */
const itemUrlRule: ClassifyRule = (signals) =>
    signals.looksLikeItemUrl && signals.headings.h1 === 1
        ? {
              type: 'detail',
              confidence: 'high',
              reasons: ['the URL names one item and the page has a single h1'],
          }
        : null;

const strongOverviewRule: ClassifyRule = (signals, hasCluster) =>
    hasCluster && signals.topClusterSize >= 3 && signals.topClusterLinks
        ? {
              type: 'overview',
              confidence: 'high',
              reasons: [
                  `${signals.topClusterSize} repeating items covering ${(signals.topClusterAreaShare * 100).toFixed(0)}% of the viewport, each linking somewhere`,
              ],
          }
        : null;

const weakOverviewRule: ClassifyRule = (signals, hasCluster) =>
    hasCluster && signals.topClusterSize >= 3
        ? {
              type: 'overview',
              confidence: 'low',
              reasons: [
                  `${signals.topClusterSize} repeating items, but none of them link anywhere — ` +
                      `this may be a table rather than a list of items`,
              ],
          }
        : null;

const searchRule: ClassifyRule = (signals, hasCluster) =>
    signals.searchInputCount >= 1 && !hasCluster
        ? {
              type: 'search',
              confidence: 'medium',
              reasons: ['a search input and no list of results'],
          }
        : null;

const rootRule: ClassifyRule = (signals) => {
    const atRoot =
        signals.pathSegments.length === 0 ||
        (signals.pathSegments.length === 1 &&
            /^index\.\w+$/.test(signals.pathSegments[0]!));
    return atRoot
        ? {
              type: 'home',
              confidence: 'medium',
              reasons: ['the site root, with no list of its own'],
          }
        : null;
};

const formRule: ClassifyRule = (signals) =>
    signals.formCount >= 1 && signals.inputCount >= 2
        ? {
              type: 'form',
              confidence: 'medium',
              reasons: [
                  `a visible form with ${signals.inputCount} visible input(s)`,
              ],
          }
        : null;

const singleH1Rule: ClassifyRule = (signals) =>
    signals.headings.h1 === 1
        ? {
              type: 'detail',
              confidence: 'low',
              reasons: [
                  'a single h1 and nothing else distinctive — worth a second look',
              ],
          }
        : null;

/** Checked in order; the first rule that applies decides the classification. */
const CLASSIFY_RULES: ClassifyRule[] = [
    postFormRule,
    itemUrlRule,
    strongOverviewRule,
    weakOverviewRule,
    searchRule,
    rootRule,
    formRule,
    singleH1Rule,
];

export function classifyPage(
    signals: PageSignals,
    hasCluster: boolean,
): Classification {
    for (const rule of CLASSIFY_RULES) {
        const result = rule(signals, hasCluster);
        if (result) return result;
    }
    return {
        type: 'home',
        confidence: 'low',
        reasons: ['no signal was decisive; the agent should classify this one'],
    };
}

/**
 * Generalise visited URLs into the pattern the graph stores. A pattern is what
 * makes a page a *kind* of page rather than one address.
 *
 *   ["/product/1.html", "/product/2.html"] -> "/product/:id.html"
 */
export function derivePattern(urls: string[]): string {
    const paths = urls
        .map((u) => {
            try {
                return new URL(u).pathname;
            } catch {
                return null;
            }
        })
        .filter((p): p is string => p !== null);

    if (paths.length === 0) return '/';
    if (paths.length === 1) return generaliseSingle(paths[0]!);

    const split = paths.map((p) => p.split('/'));
    const width = Math.max(...split.map((s) => s.length));
    const out: string[] = [];

    for (let i = 0; i < width; i++) {
        const values = split.map((s) => s[i] ?? '');
        const unique = new Set(values);
        if (unique.size === 1) {
            out.push(values[0] ?? '');
            continue;
        }
        out.push(placeholderFor([...unique]));
    }
    return out.join('/') || '/';
}

function generaliseSingle(path: string): string {
    return path
        .split('/')
        .map((segment) => {
            if (!segment) return segment;
            const match = /^(.*?)(\.\w+)$/.exec(segment);
            const stem = match ? match[1]! : segment;
            const ext = match ? match[2]! : '';
            if (/^\d+$/.test(stem)) return `:id${ext}`;
            return `${stem}${ext}`;
        })
        .join('/');
}

function placeholderFor(values: string[]): string {
    const stems = values.map((v) => {
        const match = /^(.*?)(\.\w+)$/.exec(v);
        return { stem: match ? match[1]! : v, ext: match ? match[2]! : '' };
    });
    const ext = stems.every((s) => s.ext === stems[0]!.ext)
        ? stems[0]!.ext
        : '';
    const name = stems.every((s) => /^\d+$/.test(s.stem)) ? ':id' : ':slug';
    return `${name}${ext}`;
}
