import { parseArgs } from 'node:util';
import { withPage } from '../../browser/session.js';
import { observePage, primaryCluster } from '../../analyzer/observe.js';
import { classifyPage } from '../../analyzer/classify.js';
import { findFieldCandidates } from '../../analyzer/fields.js';
import { tierElements } from '../../analyzer/risk.js';
import { artifactsDir, domainKey } from '../../graph/store.js';
import { join } from 'node:path';
import { EXIT, UsageError, isHelpFlag } from '../exit.js';

/**
 * The agent's window onto a page: everything mechanical that can be said about
 * it, with no decision taken. The draft classification is included and clearly
 * labelled as a draft, so the agent can agree or overrule it.
 */

const OBSERVE_USAGE = `wgraph observe <url> [options]

Describe one page in full, with no decision taken — no graph is written.
Useful for inspecting what the analyzer sees before trusting its draft
classification.

Options:
  --json         Print the full observation as JSON
  --fields       Also list candidate field locators found on the page
  --screenshot   Save a screenshot alongside the observation
  --headed       Show the browser window instead of running headless`;

export async function observeCommand(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(OBSERVE_USAGE);
        return EXIT.OK;
    }
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            json: { type: 'boolean', default: false },
            fields: { type: 'boolean', default: false },
            screenshot: { type: 'boolean', default: false },
            headed: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });

    const target = positionals[0];
    if (!target)
        throw new UsageError('wgraph observe <url> [--json] [--fields]');
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target)
        ? target
        : `https://${target}`;

    const result = await withPage(
        { url, headless: !values.headed },
        async (page) => {
            const screenshotPath = values.screenshot
                ? join(artifactsDir(domainKey(url)), `${Date.now()}.png`)
                : undefined;

            const observation = await observePage(
                page,
                screenshotPath ? { screenshotPath } : {},
            );
            const cluster = primaryCluster(observation.clusters);
            const draft = classifyPage(
                observation.signals,
                cluster !== undefined,
            );
            const tiers = tierElements(observation.elements, {
                origin: new URL(page.url()).origin,
            });
            const fields = values.fields
                ? await findFieldCandidates(page)
                : null;

            return { observation, cluster, draft, tiers, fields };
        },
    );

    if (values.json) {
        console.log(
            JSON.stringify(
                {
                    ...result.observation,
                    draftClassification: result.draft,
                    primaryCluster: result.cluster ?? null,
                    risk: {
                        safe: result.tiers.safe.map((e) => e.ref),
                        confirm: result.tiers.confirm.map((e) => e.ref),
                        blocked: result.tiers.blocked.map((e) => e.ref),
                    },
                    fieldCandidates: result.fields,
                },
                null,
                2,
            ),
        );
        return EXIT.OK;
    }

    const { observation, cluster, draft, tiers, fields } = result;
    const lines = [
        `${observation.url}`,
        `"${observation.title}"`,
        '',
        `Draft page type: ${draft.type} (${draft.confidence}) — ${draft.reasons.join('; ')}`,
        `  This is a guess from counted signals. Overrule it if the page does not fit.`,
        '',
        `Elements: ${observation.elements.length}  ` +
            `(${tiers.safe.length} safe to probe, ${tiers.confirm.length} need approval, ` +
            `${tiers.blocked.length} off limits)`,
        `Accessibility tree: ${observation.accessibility ? `${observation.accessibility.length} nodes` : 'unavailable'}`,
    ];

    if (cluster) {
        lines.push(
            '',
            `List: ${cluster.count} x ${cluster.itemCss} in ${cluster.containerCss}`,
            `  click target: ${cluster.clickTargetCss ?? 'none'}`,
        );
    } else {
        lines.push('', 'List: none found');
    }

    const rejected = observation.clusters.filter((c) => c.excluded);
    if (rejected.length > 0) {
        lines.push('', 'Rejected repeating structures:');
        for (const c of rejected) {
            lines.push(`  ${c.count} x ${c.itemCss} — ${c.exclusionReason}`);
        }
    }

    if (fields) {
        lines.push('', 'Field candidates:');
        for (const f of fields) {
            lines.push(
                `  ${f.suggestedName.padEnd(14)} ${f.css}  (${f.confidence}: ${f.reason})`,
            );
        }
    }

    if (observation.screenshot)
        lines.push('', `Screenshot: ${observation.screenshot}`);

    console.log(lines.join('\n'));
    return EXIT.OK;
}
