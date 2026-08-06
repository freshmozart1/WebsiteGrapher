import { parseArgs } from 'node:util';
import { loadGraph } from '../../graph/store.js';
import { buildPlan, type PlanTarget } from '../../planner/plan.js';
import { interpretQuestion } from '../../planner/goals.js';
import { renderPlan } from '../render.js';
import { EXIT, UsageError, isHelpFlag } from '../exit.js';
import { requireDomain } from './graph.js';

/**
 * `plan` takes an explicit target — this is the path the agent uses, having
 * already decided what the question is about.
 */

const PLAN_USAGE = `wgraph plan <domain> (--field <name> | --goal <id> | --page <id>) [--json]

Route to a target the caller already identified: a field by its semantic
name, a stored goal by id, or a page by id. Exactly one of the three is
required.

Options:
  --field <name>   Route to a field by semantic name
  --goal <id>      Route to a stored goal by id
  --page <id>      Route to a page by id
  --json           Print the plan as JSON

Exit codes: 0 a route was found, 2 the graph holds no route to it.`;

export async function planCommand(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(PLAN_USAGE);
        return EXIT.OK;
    }
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            field: { type: 'string' },
            goal: { type: 'string' },
            page: { type: 'string' },
            json: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });
    const domain = requireDomain(
        positionals[0],
        'wgraph plan <domain> (--field <name> | --goal <id> | --page <id>)',
    );

    const chosen = [values.field, values.goal, values.page].filter(Boolean);
    if (chosen.length !== 1) {
        throw new UsageError(
            'Pass exactly one of --field <name>, --goal <id> or --page <id>.',
        );
    }

    const target: PlanTarget = values.field
        ? { kind: 'field', semanticName: values.field }
        : values.goal
          ? { kind: 'goal', goalId: values.goal }
          : { kind: 'page', pageId: values.page as string };

    const graph = await loadGraph(domain);
    const plan = buildPlan(graph, target);
    emit(plan, values.json);
    return plan.ok ? EXIT.OK : EXIT.GAP;
}

/**
 * `ask` interprets the question itself. That interpretation is a deterministic
 * keyword match, not reasoning — it exists so the CLI stands alone. It reports
 * its confidence so a poor guess is visible rather than silently authoritative.
 */
const ASK_USAGE = `wgraph ask <domain> "<question>" [--json]

Interpret a free-text question with a deterministic keyword match, then
route to whatever it names — a field, a stored goal, or a page. Reports its
confidence, so a poor guess is visible rather than silently authoritative.

Options:
  --json   Print the plan as JSON

Exit codes: 0 a route was found, 2 the question could not be placed or the
graph holds no route to it.`;

export async function askCommand(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(ASK_USAGE);
        return EXIT.OK;
    }
    const { values, positionals } = parseArgs({
        args: argv,
        options: { json: { type: 'boolean', default: false } },
        allowPositionals: true,
    });
    const domain = requireDomain(
        positionals[0],
        'wgraph ask <domain> "<question>"',
    );
    const question = positionals.slice(1).join(' ').trim();
    if (!question) throw new UsageError('wgraph ask <domain> "<question>"');

    const graph = await loadGraph(domain);
    const reading = interpretQuestion(graph, question);

    if (reading.kind === 'none') {
        const plan = {
            ok: false as const,
            question,
            reason: `Could not tell what "${question}" is asking about.`,
            detail: [reading.reason],
            suggestion:
                'Name the target explicitly: wgraph plan <domain> --field <name>, ' +
                'or run `wgraph graph show <domain>` to see what was learned.',
        };
        emit(plan, values.json);
        return EXIT.GAP;
    }

    const target: PlanTarget =
        reading.kind === 'goal'
            ? { kind: 'goal', goalId: reading.goalId as string }
            : reading.kind === 'field'
              ? { kind: 'field', semanticName: reading.semanticName as string }
              : { kind: 'page', pageId: reading.pageId as string };

    const plan = buildPlan(graph, target, {
        question,
        confidence: reading.confidence,
    });

    if (
        plan.ok &&
        reading.confidence !== 'high' &&
        reading.alternatives.length > 0
    ) {
        plan.notes.push(
            `Read as ${reading.reason}. Other readings: ${reading.alternatives.join(', ')}.`,
        );
    }

    emit(plan, values.json);
    return plan.ok ? EXIT.OK : EXIT.GAP;
}

function emit(plan: unknown, json: boolean | undefined): void {
    console.log(
        json ? JSON.stringify(plan, null, 2) : renderPlan(plan as never),
    );
}
