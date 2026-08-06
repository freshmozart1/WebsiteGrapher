import type { Page } from 'playwright';
import type { GraphPatch } from '../graph/mutate.js';
import {
    BUILTIN_VOCABULARY,
    type LocatorDefinition,
    type ProbeCandidate,
} from '../graph/schema.js';
import type { NormalizedElement } from './elements.js';
import { startRun, finishRun } from '../browser/session.js';
import { synthesizeLocator } from '../locator/synthesize.js';
import {
    observePage,
    primaryCluster,
    type PageObservation,
} from './observe.js';
import { classifyPage, derivePattern } from './classify.js';
import { detectPagination } from './controls.js';
import {
    crossValidate,
    findFieldCandidates,
    type FieldCandidate,
} from './fields.js';
import { ProbeRefused, describe, probeElement } from './probe.js';
import { assessRisk, type RiskTier } from './risk.js';
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

type StateDimensions = NonNullable<
    NonNullable<GraphPatch['pages']>[number]['stateDimensions']
>;

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

        // --- Phases 1-2: the entry page, and finding the page that lists things
        const overview = await establishOverview(
            page,
            scope,
            budget,
            patch,
            say,
        );
        if (!overview) {
            say('no page with a repeating list was reached within budget');
            return done();
        }

        // --- Phase 3: the list ---------------------------------------------
        const { cluster, listId } = await recordListComponent(
            page,
            overview,
            patch,
            say,
        );

        // --- Phase 4: which controls actually filter the list ---------------
        const controlProbe = await probeListControls(page, overview, cluster, {
            origin,
            budget,
            approved,
            patch,
            pending,
            say,
        });
        if (controlProbe.stoppedBy) stoppedBy = controlProbe.stoppedBy;

        // --- Phase 5: pagination -------------------------------------------
        await detectAndRecordPagination(
            page,
            overview,
            cluster,
            controlProbe.stateDimensions,
            budget,
            patch,
            say,
        );

        const overviewPage = patch.pages!.find((p) => p.id === overview.id);
        if (overviewPage && controlProbe.stateDimensions.length > 0) {
            overviewPage.stateDimensions = controlProbe.stateDimensions;
        }

        // --- Phases 6-7: the detail page ------------------------------------
        const detailSampling = await sampleDetailPages(
            page,
            cluster,
            scope,
            budget,
        );
        if (detailSampling.stoppedBy) stoppedBy = detailSampling.stoppedBy;

        if (detailSampling.samples.length === 0) {
            say(
                'the list items do not link anywhere, so there is no detail page to learn',
            );
            return done();
        }
        if (detailSampling.visited.length === 0) return done();

        recordDetailFindings(
            patch,
            listId,
            cluster,
            detailSampling.detailClass,
            detailSampling.perPage,
            detailSampling.visited,
            say,
        );

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

/**
 * Phases 1-2: classify the entry page, then either use it directly (when it
 * carries the list itself) or follow navigation to find the page that does.
 */
async function establishOverview(
    page: Page,
    scope: Scope,
    budget: Budget,
    patch: GraphPatch,
    say: (line: string) => void,
): Promise<{ id: string; obs: PageObservation } | null> {
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

    // The list has to lead somewhere. A specification table repeats just as
    // convincingly and leads nowhere, so a cluster with no click target is not
    // the thing we are looking for.
    if (entryCluster?.clickTargetCss) {
        say('the entry page carries the list itself');
        return { id: entryId, obs: entryObs };
    }

    return await findOverview(page, entryObs, scope, budget, patch, entryId, say);
}

/** Phase 3: record the overview page's repeating list as a component. */
async function recordListComponent(
    page: Page,
    overview: { id: string; obs: PageObservation },
    patch: GraphPatch,
    say: (line: string) => void,
): Promise<{
    cluster: NonNullable<ReturnType<typeof navigableCluster>>;
    listId: string;
}> {
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
    return { cluster, listId };
}

/**
 * Phase 4: probe each control on the overview page to see which ones
 * actually filter or reorder the list, queuing anything risky for approval.
 */
async function probeListControls(
    page: Page,
    overview: { id: string; obs: PageObservation },
    cluster: NonNullable<ReturnType<typeof navigableCluster>>,
    context: {
        origin: string;
        budget: Budget;
        approved: Set<string>;
        patch: GraphPatch;
        pending: ProbeCandidate[];
        say: (line: string) => void;
    },
): Promise<{ stateDimensions: StateDimensions; stoppedBy: string | null }> {
    const { origin, budget, approved, patch, pending, say } = context;
    const stateDimensions: StateDimensions = [];

    for (const el of overview.obs.elements) {
        if (!budget.canProbe()) {
            return { stateDimensions, stoppedBy: 'maxProbes' };
        }
        if (!el.visible || el.tag === 'a') continue;

        const resolved = await locatorForControl(page, el, origin);
        if (!resolved) continue;
        const { tier, reason, locator } = resolved;

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

        const stopReason = await probeAndRecordControl(
            page,
            el,
            locator,
            overview,
            cluster,
            budget,
            patch,
            stateDimensions,
            say,
        );
        if (stopReason) return { stateDimensions, stoppedBy: stopReason };
    }

    return { stateDimensions, stoppedBy: null };
}

/** The element's risk tier and a locator for it, or null if it can't be probed at all. */
async function locatorForControl(
    page: Page,
    el: NormalizedElement,
    origin: string,
): Promise<{ tier: RiskTier; reason: string; locator: LocatorDefinition } | null> {
    const { tier, reason } = assessRisk(el, { origin });
    if (tier === 'blocked') return null;

    const locator = await synthesizeLocator(page, el);
    if (!locator) return null;

    return { tier, reason, locator };
}

/**
 * Run one probe and record its effect on the graph. Returns the budget limit
 * name if the budget was exceeded, so the caller can stop the whole loop.
 */
async function probeAndRecordControl(
    page: Page,
    el: NormalizedElement,
    locator: LocatorDefinition,
    overview: { id: string; obs: PageObservation },
    cluster: NonNullable<ReturnType<typeof navigableCluster>>,
    budget: Budget,
    patch: GraphPatch,
    stateDimensions: StateDimensions,
    say: (line: string) => void,
): Promise<string | null> {
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
        recordControlProbeResult(
            el,
            locator,
            result,
            overview.id,
            patch,
            stateDimensions,
        );
        return null;
    } catch (err) {
        if (err instanceof ProbeRefused) return null;
        if (err instanceof BudgetExceeded) return err.limit;
        say(`probe ${describe(el)}: failed (${(err as Error).message})`);
        return null;
    }
}

/** A probe that changed the list becomes a filter/sort component and state dimension. */
function recordControlProbeResult(
    el: NormalizedElement,
    locator: LocatorDefinition,
    result: Awaited<ReturnType<typeof probeElement>>,
    overviewId: string,
    patch: GraphPatch,
    stateDimensions: StateDimensions,
): void {
    if (result.change.kind !== 'list-changed') return;

    const compId = `comp-filter-${el.ref}`;
    patch.components!.push({
        id: compId,
        pageId: overviewId,
        type: 'filter',
        locator,
        meta: {
            controlKind: controlKindOf(el.tag, el.type, el.role),
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

/** Phase 5: detect pagination on the overview page and record it as a component. */
async function detectAndRecordPagination(
    page: Page,
    overview: { id: string; obs: PageObservation },
    cluster: NonNullable<ReturnType<typeof navigableCluster>>,
    stateDimensions: StateDimensions,
    budget: Budget,
    patch: GraphPatch,
    say: (line: string) => void,
): Promise<void> {
    await gotoIfNeeded(page, overview.obs.url);
    if (!budget.canProbe()) return;

    const pagination = await detectPagination(
        page,
        overview.obs.elements,
        cluster.containerCss,
    );
    if (!pagination) {
        say('pagination: none found');
        return;
    }

    const compId = 'comp-pagination';
    patch.components!.push({
        id: compId,
        pageId: overview.id,
        type: 'pagination',
        locator: pagination.locator ?? { css: cluster.containerCss },
        meta: { paginationMode: pagination.mode },
    });
    stateDimensions.push({
        id: 'dim-pagination',
        kind: 'pagination',
        componentId: compId,
        valueSource: 'numeric',
    });
    say(`pagination: ${pagination.mode} — ${pagination.evidence}`);
}

/** Phases 6-7 (part 1): visit a sample of detail pages and collect field candidates. */
async function sampleDetailPages(
    page: Page,
    cluster: NonNullable<ReturnType<typeof navigableCluster>>,
    scope: Scope,
    budget: Budget,
): Promise<{
    samples: string[];
    perPage: FieldCandidate[][];
    visited: string[];
    detailClass: ReturnType<typeof classifyPage> | null;
    stoppedBy: string | null;
}> {
    const samples = cluster.sampleHrefs
        .filter((href) => inScope(scope, href).allowed)
        .slice(0, budget.limits.detailSamples);

    const perPage: FieldCandidate[][] = [];
    const visited: string[] = [];
    let detailClass: ReturnType<typeof classifyPage> | null = null;

    for (const href of samples) {
        if (!budget.canVisit()) {
            return { samples, perPage, visited, detailClass, stoppedBy: 'maxPages' };
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

    return { samples, perPage, visited, detailClass, stoppedBy: null };
}

/**
 * Phases 6-7 (part 2): record the detail page, the edge that reaches it, and
 * every field position that held across all sampled detail pages.
 */
function recordDetailFindings(
    patch: GraphPatch,
    listId: string,
    cluster: NonNullable<ReturnType<typeof navigableCluster>>,
    detailClass: ReturnType<typeof classifyPage> | null,
    perPage: FieldCandidate[][],
    visited: string[],
    say: (line: string) => void,
): void {
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

    recordCrossValidatedFields(patch, detailId, perPage, say);
    recordFieldGoals(patch, detailId);
}

/**
 * A position only counts if it held on every sample. Anything that did not
 * was a property of one item, not of the page type.
 */
function recordCrossValidatedFields(
    patch: GraphPatch,
    detailId: string,
    perPage: FieldCandidate[][],
    say: (line: string) => void,
): void {
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
}

function recordFieldGoals(patch: GraphPatch, detailId: string): void {
    for (const field of patch.fields!) {
        if (!field.verified) continue;
        patch.goals!.push({
            id: `goal-${field.semanticName}`,
            name: `Find the ${field.semanticName} of an item`,
            targetField: field.id!,
            targetPage: detailId,
        });
    }
}

/**
 * Follow the site's own navigation until a page with a real list turns up.
 *
 * Every candidate visited along the way gets recorded as a page — with an
 * edge back to the entry page when the link into it could be pinned down —
 * whether or not it turns out to be the overview. The browser already paid
 * for the visit; discarding a candidate that did not carry the list would
 * throw that visit away, and it is still a page a user can reach.
 */
async function findOverview(
    page: Page,
    entry: PageObservation,
    scope: Scope,
    budget: Budget,
    patch: GraphPatch,
    entryId: string,
    say: (line: string) => void,
): Promise<{ id: string; obs: PageObservation } | null> {
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
    const deduped: NormalizedElement[] = [];
    for (const el of candidates) {
        const path = new URL(el.href!).pathname;
        if (seen.has(path)) continue;
        seen.add(path);
        deduped.push(el);
    }

    // Locators can only be verified against the DOM that is currently loaded
    // (`verifyLocator` runs `locator.count()` against whatever `page` shows),
    // so every candidate's locator has to be synthesized now, in one pass,
    // while `page` still shows the entry page — before any of the candidates
    // below get visited and navigate away from it.
    const locators = new Map<string, LocatorDefinition | null>();
    for (const el of deduped) {
        locators.set(el.ref, await synthesizeLocator(page, el));
    }

    let navCount = 0;
    for (const el of deduped) {
        if (!budget.canVisit()) return null;

        budget.visit();
        await page.goto(el.href!, { waitUntil: 'domcontentloaded' });
        const obs = await observePage(page);
        const cluster = navigableCluster(obs);
        const classification = classifyPage(obs.signals, cluster !== undefined);
        const path = new URL(el.href!).pathname;
        say(
            `${path} -> ${classification.type} (${classification.reasons.join('; ')})`,
        );

        if (cluster?.clickTargetCss) {
            const overviewId = 'page-overview';
            patch.pages!.push({
                id: overviewId,
                type: classification.type,
                urlPattern: derivePattern([obs.url]),
            });
            const linkLocator = locators.get(el.ref) ?? null;
            if (linkLocator) {
                patch.edges!.push({
                    id: 'edge-entry-to-overview',
                    sourceNode: entryId,
                    targetNode: overviewId,
                    action: 'click',
                    locator: linkLocator,
                });
            } else {
                say('could not pin down the link into the overview page');
            }
            return { id: overviewId, obs };
        }

        // No usable list here, but it is still a page a user can reach: record
        // it and the nav edge into it (when the link resolved) rather than
        // silently discarding a visit the budget already paid for.
        navCount++;
        const navId = `page-nav-${navCount}`;
        patch.pages!.push({
            id: navId,
            type: classification.type,
            urlPattern: derivePattern([obs.url]),
        });
        const navLocator = locators.get(el.ref) ?? null;
        if (navLocator) {
            patch.edges!.push({
                id: `edge-entry-to-nav-${navCount}`,
                sourceNode: entryId,
                targetNode: navId,
                action: 'click',
                locator: navLocator,
            });
        }
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
