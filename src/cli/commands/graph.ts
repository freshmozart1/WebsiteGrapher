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
import { EXIT, UsageError, isHelpFlag } from '../exit.js';

const GRAPH_USAGE = `wgraph graph <subcommand> [args...]

Inspecting:
  wgraph graph list                       Sites that have been learned
  wgraph graph show <domain>              Everything known about a site
  wgraph graph show <domain> --vocabulary Page/component/field vocabulary in use
  wgraph graph validate <domain>          Check the graph is sound

Writing:
  wgraph graph apply <domain> --file -    Apply a JSON patch (stdin)
  wgraph graph add-type <domain> <page|component|field> <name> --description "..."
  wgraph graph set-entry <domain> <pageId>

Each subcommand also accepts -h / --help for its own usage.`;

export async function graphCommand(argv: string[]): Promise<number> {
    const sub = argv[0];
    const rest = argv.slice(1);
    if (isHelpFlag([sub ?? ''])) {
        console.log(GRAPH_USAGE);
        return EXIT.OK;
    }
    switch (sub) {
        case 'list':
            return await list(rest);
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

const LIST_USAGE = `wgraph graph list — Sites that have been learned.`;

async function list(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(LIST_USAGE);
        return EXIT.OK;
    }
    const domains = await listGraphs();
    if (domains.length === 0) {
        console.log('No sites learned yet. Start with: wgraph analyze <url>');
        return EXIT.OK;
    }
    for (const d of domains) console.log(d);
    return EXIT.OK;
}

const SHOW_USAGE = `wgraph graph show <domain> [options]

Print everything known about a site's graph.

Options:
  --vocabulary   Print the page/component/field vocabulary in use instead
  --json         Print the raw graph as JSON instead

Exit code: 3 instead of 0 if the graph has approvals pending.`;

async function show(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(SHOW_USAGE);
        return EXIT.OK;
    }
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

const VALIDATE_USAGE = `wgraph graph validate <domain>

Load a site's graph and report whether it is sound: every id referenced
exists, every type/name is registered, field locators are structural. Throws
a validation error naming the offending path if it is not.`;

async function validate(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(VALIDATE_USAGE);
        return EXIT.OK;
    }
    const domain = requireDomain(argv[0], 'wgraph graph validate <domain>');
    const graph = await loadGraph(domain); // throws GraphValidationError if broken
    console.log(
        `OK — ${graph.pages.length} pages, ${graph.components.length} components, ` +
            `${graph.edges.length} actions, ${graph.fields.length} fields.`,
    );
    return EXIT.OK;
}

const APPLY_USAGE = `wgraph graph apply <domain> --file <path>|-  [--patch '<json>'] [--origin <url>]

Apply a JSON patch to a graph, validating the result before it is written.
Every top-level key is optional and additive — write what changed, not the
whole graph. Ids on nodes are optional; omit them and a readable id is
generated. A graph that does not exist yet is created on first apply.

Options:
  --file <path>    Read the patch from a file ("-" reads stdin)
  --patch <json>   Pass the patch inline instead of a file
  --origin <url>   Origin to seed a graph that does not exist yet

Patch shape:

{
  "entryPageId": "page-home",   // alternative to "entry" on a page below

  "vocabulary": {
    // Every page type, component type and field name below must be
    // registered here (or already registered, e.g. with "wgraph graph
    // add-type") before validation will accept a node that uses it.
    "pageTypes":      [{ "name": "checkout-step", "description": "One step of a multi-step purchase flow" }],
    "componentTypes": [{ "name": "carousel", "description": "..." }],
    "fieldNames":     [{ "name": "sku", "description": "..." }]
  },

  "pages": [
    {
      "id": "page-home",            // optional; generated from "type" if omitted
      "type": "home",               // must be a registered page type
      "urlPattern": "/",            // a pattern, not a visited URL, e.g. "/catalogue/:slug"
      "components": ["comp-list"],  // optional — component ids on this page; a
                                     // component's own "pageId" adds it here too
      "entry": true                 // marks this page as where plans start
    }
  ],

  "components": [
    {
      "id": "comp-list",
      "pageId": "page-home",         // must name a page in this patch or already on the graph
      "type": "list",                // must be a registered component type
      "locator": { "role": "list", "name": "Products" },  // the container
      "meta": {
        "itemLocator": { "css": ".product" },        // one item inside the container
        "clickTargetLocator": { "role": "link" },     // clicked to reach the item's detail page
        "paginationMode": "next",    // numbered | next | load-more | infinite-scroll
        "controlKind": "select"      // checkbox | select | search | tab | radio | button
      }
    }
  ],

  "fields": [
    {
      "id": "field-price",
      "pageId": "page-detail",
      "semanticName": "price",        // must be a registered field name
      "locator": { "css": ".price" }, // structural only — never "text" or "name"
      "verified": false,
      "valueShape": "currency"        // currency | text | url | number
    }
  ],

  "edges": [
    {
      "id": "edge-1",
      "sourceNode": "page-home",      // a page or a component id
      "targetNode": "page-detail",    // always a page — edges model navigation
      "action": "click",              // click | fill | select | scroll | navigate
      "locator": { "role": "link", "name": "View" }
    }
  ]
}

Locators (components, fields, edges) are a ranked hint set — populate every
hint that resolves, not just one: { role, name, label, placeholder, text,
css, xpath }. Field locators must be structural: "text"/"name" pin to one
item's displayed value rather than the field itself, and are rejected.

An unregistered type/name fails validation with the exact
\`wgraph graph add-type\` command needed to register it.`;

async function apply(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(APPLY_USAGE);
        return EXIT.OK;
    }
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
const ADD_TYPE_USAGE = `wgraph graph add-type <domain> <page|component|field> <name> --description "..."

Register a page type, component type or field name in the graph's
vocabulary, so nodes can use it. Registering is deliberately its own
command: it should look like the decision it is, not a side effect of
writing a node.

Options:
  --description <text>   Required. What stops the next run inventing a synonym.`;

async function addType(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(ADD_TYPE_USAGE);
        return EXIT.OK;
    }
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

const SET_ENTRY_USAGE = `wgraph graph set-entry <domain> <pageId>

Set which page is where plans start. Equivalent to passing "entryPageId" (or
a page's "entry": true) to \`wgraph graph apply\`.`;

async function setEntry(argv: string[]): Promise<number> {
    if (isHelpFlag(argv)) {
        console.log(SET_ENTRY_USAGE);
        return EXIT.OK;
    }
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
