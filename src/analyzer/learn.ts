import type { Page } from 'playwright';
import type { GraphPatch } from '../graph/mutate.js';
import { BUILTIN_VOCABULARY, type ProbeCandidate } from '../graph/schema.js';
import { startRun, finishRun } from '../browser/session.js';
import { synthesizeLocator } from '../locator/synthesize.js';
import {
    observePage,
    primaryCluster,
    type PageObservation,
} from './observe.js';
import { classifyPage, derivePattern } from './classify.js';
import { detectPagination } from './controls.js';
import { crossValidate, findFieldCandidates } from './fields.js';
import { ProbeRefused, describe, probeElement } from './probe.js';
import { assessRisk } from './risk.js';
import {
    Budget,
    BudgetExceeded,
    DEFAULT_BUDGETS,
    fetchRobots,
    inScope,
    type Budgets,
    type Scope,
} from './limits.js';

/**
 * Phases 1-7, in order, against a live site.
 *
 * The result is a graph patch plus a queue of probes that need the user's
 * approval. Nothing is written to disk here — the caller decides what to do
 * with both, which keeps this testable without a store.
 *
 * Page types and field names assigned here are drafts from `classifyPage` and
 * `findFieldCandidates`. The agent is expected to review them against the same
 * observations and correct anything that does not fit.
 */

export interface LearnOptions {
    startUrl: string;
    headless?: boolean;
    budgets?: Partial<Budgets>;
    /** Probe candidate ids the user has approved since the last checkpoint. */
    approved?: string[];
    log?: (line: string) => void;
}

export interface LearnOutcome {
    patch: GraphPatch;
    pending: ProbeCandidate[];
    log: string[];
    spent: { pages: number; probes: number; ms: number };
    /** Set when a budget stopped the run early. */
    stoppedBy: string | null;
}

const BUILTIN_FIELD_NAMES = new Set(
    BUILTIN_VOCABULARY.fieldNames.map((e) => e.name),
);

export async function learnSite(options: LearnOptions): Promise<LearnOutcome> {
    const log: string[] = [];
    const say = (line: string) => {
        log.push(line);
        options.log?.(line);
    };

    const origin = new URL(options.startUrl).origin;
    const budget = new Budget({ ...DEFAULT_BUDGETS, ...options.budgets });
    const scope: Scope = { origin, robots: await fetchRobots(origin) };
    say(
        scope.robots.absent
            ? 'robots.txt: none found, nothing disallowed'
            : `robots.txt: ${scope.robots.disallow.length} disallow rule(s)`,
    );

    const approved = new Set(options.approved ?? []);
    const pending: ProbeCandidate[] = [];
    const patch: GraphPatch = {
        vocabulary: { pageTypes: [], componentTypes: [], fieldNames: [] },
        pages: [],
        components: [],
        edges: [],
        fields: [],
        goals: [],
        pendingApprovals: [],
    };

    const run = await startRun({
        url: options.startUrl,
        headless: options.headless ?? true,
    });
    let stoppedBy: string | null = null;

    try {
        const page = run.page;

        // --- Phases 1-2: the entry page ------------------------------------
        budget.visit();
        const entryObs = await observePage(page);
        const entryCluster = primaryCluster(entryObs.clusters);
        const entryClass = classifyPage(
            entryObs.signals,
            entryCluster !== undefined,
        );
        say(
            `entry ${entryObs.signals.path} -> ${entryClass.type} (${entryClass.confidence}: ${entryClass.reasons.join('; ')})`,
        );

        const entryId = 'page-entry';
        patch.pages!.push({
            id: entryId,
            type: entryClass.type,
            urlPattern: derivePattern([entryObs.url]),
            entry: true,
        });

        // --- Find the page that lists things -------------------------------
        let overview: { id: string; obs: PageObservation } | null = null;

        // The list has to lead somewhere. A specification table repeats just as
        // convincingly and leads nowhere, so a cluster with no click target is not
        // the thing we are looking for.
        if (entryCluster?.clickTargetCss) {
            say('the entry page carries the list itself');
            overview = { id: entryId, obs: entryObs };
        } else {
            const found = await findOverview(
                page,
                entryObs,
                scope,
                budget,
                say,
            );
            if (found) {
                const overviewId = 'page-overview';
                patch.pages!.push({
                    id: overviewId,
                    type: found.classification.type,
                    urlPattern: derivePattern([found.obs.url]),
                });
                const linkLocator = await synthesizeLocatorOn(page, found, say);
                if (linkLocator) {
                    patch.edges!.push({
                        id: 'edge-entry-to-overview',
                        sourceNode: entryId,
                        targetNode: overviewId,
                        action: 'click',
                        locator: linkLocator,
                    });
                }
                overview = { id: overviewId, obs: found.obs };
            }
        }

        if (!overview) {
            say('no page with a repeating list was reached within budget');
            return done();
        }

        // --- Phase 3: the list ---------------------------------------------
        await gotoIfNeeded(page, overview.obs.url);
        const cluster = navigableCluster(overview.obs)!;
        const listId = 'comp-list';
        patch.components!.push({
            id: listId,
            pageId: overview.id,
            type: 'list',
            locator: { css: cluster.containerCss },
            meta: {
                itemLocator: {
                    css: `${cluster.containerCss} > ${cluster.itemCss}`,
                },
                ...(cluster.clickTargetCss
                    ? {
                          clickTargetLocator: {
                              css: `${cluster.containerCss} > ${cluster.itemCss} ${cluster.clickTargetCss}`,
                          },
                      }
                    : {}),
            },
        });
        say(
            `list: ${cluster.count} x ${cluster.itemCss} in ${cluster.containerCss}`,
        );

        // --- Phase 4: which controls actually filter the list ---------------
        const stateDimensions: NonNullable<
            NonNullable<GraphPatch['pages']>[number]['stateDimensions']
        > = [];

        for (const el of overview.obs.elements) {
            if (!budget.canProbe()) {
                stoppedBy = 'maxProbes';
                break;
            }
            if (!el.visible || el.tag === 'a') continue;

            const { tier, reason } = assessRisk(el, { origin });
            if (tier === 'blocked') continue;

            const locator = await synthesizeLocator(page, el);
            if (!locator) continue;

            const candidateId = `probe-${el.ref}`;
            if (tier === 'confirm' && !approved.has(candidateId)) {
                pending.push({
                    id: candidateId,
                    pageId: overview.id,
                    locator,
                    description: describe(el),
                    risk: 'confirm',
                    reason,
                    observedAt: new Date().toISOString(),
                });
                continue;
            }

            try {
                budget.probe();
                const result = await probeElement(page, el, locator, {
                    containerCss: cluster.containerCss,
                    restoreUrl: overview.obs.url,
                    approved: true,
                });
                say(
                    `probe ${describe(el)}: ${result.change.kind} — ${result.change.detail}`,
                );

                if (result.change.kind === 'list-changed') {
                    const compId = `comp-filter-${el.ref}`;
                    patch.components!.push({
                        id: compId,
                        pageId: overview.id,
                        type: 'filter',
                        locator,
                        meta: {
                            controlKind: controlKindOf(
                                el.tag,
                                el.type,
                                el.role,
                            ),
                        },
                    });
                    stateDimensions.push({
                        id: `dim-${el.ref}`,
                        kind: result.change.reordered ? 'sort' : 'filter',
                        componentId: compId,
                        valueSource:
                            el.tag === 'select'
                                ? 'options'
                                : el.tag === 'input'
                                  ? 'free-text'
                                  : 'options',
                        ...(el.label ? { label: el.label } : {}),
                    });
                }
            } catch (err) {
                if (err instanceof ProbeRefused) continue;
                if (err instanceof BudgetExceeded) {
                    stoppedBy = err.limit;
                    break;
                }
                say(
                    `probe ${describe(el)}: failed (${(err as Error).message})`,
                );
            }
        }

        // --- Phase 5: pagination -------------------------------------------
        await gotoIfNeeded(page, overview.obs.url);
        if (budget.canProbe()) {
            const pagination = await detectPagination(
                page,
                overview.obs.elements,
                cluster.containerCss,
            );
            if (pagination) {
                const compId = 'comp-pagination';
                patch.components!.push({
                    id: compId,
                    pageId: overview.id,
                    type: 'pagination',
                    locator: pagination.locator ?? {
                        css: cluster.containerCss,
                    },
                    meta: { paginationMode: pagination.mode },
                });
                stateDimensions.push({
                    id: 'dim-pagination',
                    kind: 'pagination',
                    componentId: compId,
                    valueSource: 'numeric',
                });
                say(`pagination: ${pagination.mode} — ${pagination.evidence}`);
            } else {
                say('pagination: none found');
            }
        }

        const overviewPage = patch.pages!.find((p) => p.id === overview!.id);
        if (overviewPage && stateDimensions.length > 0) {
            overviewPage.stateDimensions = stateDimensions;
        }

        // --- Phases 6-7: the detail page ------------------------------------
        const samples = cluster.sampleHrefs
            .filter((href) => inScope(scope, href).allowed)
            .slice(0, budget.limits.detailSamples);

        if (samples.length === 0) {
            say(
                'the list items do not link anywhere, so there is no detail page to learn',
            );
            return done();
        }

        const perPage: Awaited<ReturnType<typeof findFieldCandidates>>[] = [];
        const visited: string[] = [];
        let detailClass: ReturnType<typeof classifyPage> | null = null;

        for (const href of samples) {
            if (!budget.canVisit()) {
                stoppedBy = 'maxPages';
                break;
            }
            budget.visit();
            await page.goto(href, { waitUntil: 'domcontentloaded' });
            const obs = await observePage(page);
            if (!detailClass) {
                detailClass = classifyPage(
                    obs.signals,
                    primaryCluster(obs.clusters) !== undefined,
                );
            }
            perPage.push(await findFieldCandidates(page));
            visited.push(page.url());
        }

        if (visited.length === 0) return done();

        const detailId = 'page-detail';
        patch.pages!.push({
            id: detailId,
            type: detailClass?.type ?? 'detail',
            urlPattern: derivePattern(visited),
        });
        say(
            `detail ${derivePattern(visited)} -> ${detailClass?.type} from ${visited.length} sample(s)`,
        );

        if (cluster.clickTargetCss) {
            patch.edges!.push({
                id: 'edge-list-to-detail',
                sourceNode: listId,
                targetNode: detailId,
                action: 'click',
                locator: {
                    css: `${cluster.containerCss} > ${cluster.itemCss} ${cluster.clickTargetCss}`,
                },
            });
        }

        // A position only counts if it held on every sample. Anything that did not
        // was a property of one item, not of the page type.
        const validated = crossValidate(perPage);
        for (const { candidate, verified } of validated) {
            if (candidate.suggestedName === 'unknown') continue;
            const fieldId = `field-${candidate.suggestedName}`;
            if (patch.fields!.some((f) => f.id === fieldId)) continue;

            if (!BUILTIN_FIELD_NAMES.has(candidate.suggestedName)) {
                registerOnce(
                    patch,
                    'fieldNames',
                    candidate.suggestedName,
                    candidate.reason,
                );
            }
            patch.fields!.push({
                id: fieldId,
                pageId: detailId,
                semanticName: candidate.suggestedName,
                locator: { css: candidate.css },
                verified,
                ...(candidate.valueShape
                    ? { valueShape: candidate.valueShape }
                    : {}),
            });
            say(
                `field ${candidate.suggestedName} at ${candidate.css} (${candidate.reason}${verified ? ', verified' : ', unverified'})`,
            );
        }

        for (const field of patch.fields!) {
            if (!field.verified) continue;
            patch.goals!.push({
                id: `goal-${field.semanticName}`,
                name: `Find the ${field.semanticName} of an item`,
                targetField: field.id!,
                targetPage: detailId,
            });
        }

        return done();
    } catch (err) {
        if (err instanceof BudgetExceeded) {
            stoppedBy = err.limit;
            say(`stopped: ${err.message}`);
            return done();
        }
        throw err;
    } finally {
        await finishRun(run);
    }

    function done(): LearnOutcome {
        patch.pendingApprovals = pending;
        return { patch, pending, log, spent: budget.spent, stoppedBy };
    }
}

/** Follow the site's own navigation until a page with a real list turns up. */
async function findOverview(
    page: Page,
    entry: PageObservation,
    scope: Scope,
    budget: Budget,
    say: (line: string) => void,
) {
    const candidates = entry.elements
        .filter((el) => el.visible && el.tag === 'a' && el.href)
        .filter((el) => inScope(scope, el.href!).allowed)
        .filter(
            (el) => new URL(el.href!).pathname !== new URL(entry.url).pathname,
        )
        .filter(
            (el) => assessRisk(el, { origin: scope.origin }).tier === 'safe',
        )
        // A site's nav and main content are its map; the footer is its small print.
        .sort((a, b) => rankLandmark(a.landmark) - rankLandmark(b.landmark));

    const seen = new Set<string>();
    for (const el of candidates) {
        const path = new URL(el.href!).pathname;
        if (seen.has(path)) continue;
        seen.add(path);
        if (!budget.canVisit()) return null;

        budget.visit();
        await page.goto(el.href!, { waitUntil: 'domcontentloaded' });
        const obs = await observePage(page);
        const cluster = navigableCluster(obs);
        if (!cluster) continue;

        const classification = classifyPage(obs.signals, true);
        say(
            `${path} -> ${classification.type} (${classification.reasons.join('; ')})`,
        );
        return { obs, classification, element: el, entryUrl: entry.url };
    }
    return null;
}

/** The best repeating cluster whose items actually lead somewhere. */
function navigableCluster(obs: PageObservation) {
    return obs.clusters.find((c) => !c.excluded && c.clickTargetCss !== null);
}

function rankLandmark(landmark: string | null): number {
    if (landmark === 'nav') return 0;
    if (landmark === 'main' || landmark === null) return 1;
    if (landmark === 'header') return 2;
    return 3; // footer, aside
}

/** The link that got us to the overview, located on the entry page. */
async function synthesizeLocatorOn(
    page: Page,
    found: { element: { ref: string }; entryUrl: string },
    say: (line: string) => void,
) {
    const current = page.url();
    await page.goto(found.entryUrl, { waitUntil: 'domcontentloaded' });
    const entryAgain = await observePage(page);
    const el = entryAgain.elements.find((e) => e.ref === found.element.ref);
    const locator = el ? await synthesizeLocator(page, el) : null;
    if (!locator) say('could not pin down the link into the overview page');
    await page.goto(current, { waitUntil: 'domcontentloaded' });
    return locator;
}

async function gotoIfNeeded(page: Page, url: string): Promise<void> {
    if (page.url() !== url) {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
    }
}

function controlKindOf(
    tag: string,
    type: string | null,
    role: string | null,
): 'checkbox' | 'select' | 'search' | 'tab' | 'radio' | 'button' {
    if (tag === 'select' || role === 'combobox') return 'select';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search' || role === 'searchbox') return 'search';
    if (role === 'tab') return 'tab';
    return 'button';
}

function registerOnce(
    patch: GraphPatch,
    kind: 'pageTypes' | 'componentTypes' | 'fieldNames',
    name: string,
    description: string,
): void {
    const list = patch.vocabulary![kind]!;
    if (!list.some((e) => e.name === name)) {
        list.push({ name, description: `Detected because ${description}` });
    }
}
