import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
    GraphPatchSchema,
    applyPatch,
    registerVocab,
    resolveVocabKind,
} from '../../graph/mutate.js';
import {
    domainKey,
    listGraphs,
    loadGraph,
    originOf,
    withGraph,
} from '../../graph/store.js';
import { renderGraph, renderVocabulary } from '../render.js';
import { EXIT, UsageError } from '../exit.js';

export async function graphCommand(argv: string[]): Promise<number> {
    const sub = argv[0];
    const rest = argv.slice(1);
    switch (sub) {
        case 'list':
            return await list();
        case 'show':
            return await show(rest);
        case 'validate':
            return await validate(rest);
        case 'apply':
            return await apply(rest);
        case 'add-type':
            return await addType(rest);
        case 'set-entry':
            return await setEntry(rest);
        default:
            throw new UsageError(
                `Unknown "graph" subcommand${sub ? ` "${sub}"` : ''}.\n` +
                    'Expected: list | show | validate | apply | add-type | set-entry',
            );
    }
}

async function list(): Promise<number> {
    const domains = await listGraphs();
    if (domains.length === 0) {
        console.log('No sites learned yet. Start with: wgraph analyze <url>');
        return EXIT.OK;
    }
    for (const d of domains) console.log(d);
    return EXIT.OK;
}

async function show(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            vocabulary: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
        allowPositionals: true,
    });
    const domain = requireDomain(positionals[0], 'wgraph graph show <domain>');
    const graph = await loadGraph(domain);

    if (values.json) {
        console.log(JSON.stringify(graph, null, 2));
    } else if (values.vocabulary) {
        console.log(renderVocabulary(graph));
    } else {
        console.log(renderGraph(graph));
    }
    return graph.pendingApprovals.length > 0 ? EXIT.PENDING_APPROVAL : EXIT.OK;
}

async function validate(argv: string[]): Promise<number> {
    const domain = requireDomain(argv[0], 'wgraph graph validate <domain>');
    const graph = await loadGraph(domain); // throws GraphValidationError if broken
    console.log(
        `OK — ${graph.pages.length} pages, ${graph.components.length} components, ` +
            `${graph.edges.length} actions, ${graph.fields.length} fields.`,
    );
    return EXIT.OK;
}

async function apply(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: {
            file: { type: 'string' },
            patch: { type: 'string' },
            origin: { type: 'string' },
        },
        allowPositionals: true,
    });
    const domain = requireDomain(
        positionals[0],
        'wgraph graph apply <domain> --file patch.json  (use "-" for stdin)',
    );

    const raw = values.patch ?? (await readPatchFile(values.file));
    const patch = GraphPatchSchema.parse(JSON.parse(raw));

    const { graph } = await withGraph(domain, (g) => applyPatch(g, patch), {
        createOrigin: originOf(values.origin ?? domain),
    });
    console.log(
        `Applied. ${graph.pages.length} pages, ${graph.components.length} components, ` +
            `${graph.edges.length} actions, ${graph.fields.length} fields.`,
    );
    return EXIT.OK;
}

async function readPatchFile(file: string | undefined): Promise<string> {
    if (!file) {
        throw new UsageError(
            "Pass the patch with --file <path>, --file - or --patch '<json>'.",
        );
    }
    if (file === '-') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin)
            chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
    }
    return await readFile(file, 'utf8');
}

/**
 * Registering a vocabulary value is deliberately its own command: adding a page
 * type is a decision, and it should look like one rather than appearing as a
 * side effect of writing a node.
 */
async function addType(argv: string[]): Promise<number> {
    const { values, positionals } = parseArgs({
        args: argv,
        options: { description: { type: 'string' } },
        allowPositionals: true,
    });
    const [domainArg, kindArg, name] = positionals;
    const domain = requireDomain(
        domainArg,
        'wgraph graph add-type <domain> <page|component|field> <name> --description "..."',
    );
    if (!kindArg || !name) {
        throw new UsageError(
            'wgraph graph add-type <domain> <page|component|field> <name> --description "..."',
        );
    }
    if (!values.description) {
        throw new UsageError(
            '--description is required: it is what stops the next run inventing a synonym.',
        );
    }
    const kind = resolveVocabKind(kindArg);

    const { result } = await withGraph(domain, (g) =>
        registerVocab(g, kind, name, values.description as string),
    );
    console.log(
        result.added
            ? `Registered ${kindArg} type "${name}".`
            : `"${name}" was already registered as a ${kindArg} type.`,
    );
    return EXIT.OK;
}

async function setEntry(argv: string[]): Promise<number> {
    const domain = requireDomain(
        argv[0],
        'wgraph graph set-entry <domain> <pageId>',
    );
    const pageId = argv[1];
    if (!pageId)
        throw new UsageError('wgraph graph set-entry <domain> <pageId>');

    await withGraph(domain, (g) => {
        g.entryPageId = pageId;
    });
    console.log(`Entry page set to "${pageId}".`);
    return EXIT.OK;
}

export function requireDomain(
    input: string | undefined,
    usage: string,
): string {
    if (!input) throw new UsageError(usage);
    return domainKey(input);
}
