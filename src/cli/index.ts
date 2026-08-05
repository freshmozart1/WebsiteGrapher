#!/usr/bin/env node
import { ZodError } from "zod";
import { GraphNotFoundError, GraphValidationError } from "../graph/store.js";
import { VocabularyError } from "../graph/mutate.js";
import { ProbeRefused } from "../analyzer/probe.js";
import { graphCommand } from "./commands/graph.js";
import { askCommand, planCommand } from "./commands/plan.js";
import { analyzeCommand, resumeCommand } from "./commands/analyze.js";
import { observeCommand } from "./commands/observe.js";
import { sessionCommand } from "./commands/session.js";
import { EXIT, UsageError } from "./exit.js";

const USAGE = `wgraph — learn a website's structure once, then answer questions from the stored graph.

Learning (opens a browser):
  wgraph analyze <url>                    Learn a site for the first time
  wgraph resume <domain> --approve <ids>  Continue after approving probes
  wgraph observe <url> --json             One page, fully described, no decisions taken

Answering (no browser involved):
  wgraph ask <domain> "<question>"        Answer from what was already learned
  wgraph plan <domain> --field <name>     Route to a named field
  wgraph plan <domain> --goal <id>        Route to a stored goal
  wgraph plan <domain> --page <id>        Route to a page

Inspecting:
  wgraph graph list                       Sites that have been learned
  wgraph graph show <domain>              Everything known about a site
  wgraph graph show <domain> --vocabulary Page/component/field vocabulary in use
  wgraph graph validate <domain>          Check the graph is sound

Writing:
  wgraph graph apply <domain> --file -    Apply a JSON patch (stdin)
  wgraph graph add-type <domain> <page|component|field> <name> --description "..."
  wgraph graph set-entry <domain> <pageId>

  wgraph session list | clear <name>      Saved browser state

Graphs live in ~/.claude/website-graphs (override with WGRAPH_HOME).
Exit codes: 0 ok, 1 error, 2 nothing learned that answers this, 3 approvals pending.`;

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      console.log(USAGE);
      return EXIT.OK;
    case "analyze":
      return await analyzeCommand(rest);
    case "resume":
      return await resumeCommand(rest);
    case "observe":
      return await observeCommand(rest);
    case "graph":
      return await graphCommand(rest);
    case "plan":
      return await planCommand(rest);
    case "ask":
      return await askCommand(rest);
    case "session":
      return await sessionCommand(rest);
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.exitCode = report(err);
  });

function report(err: unknown): number {
  if (err instanceof UsageError) {
    console.error(err.message);
    return EXIT.ERROR;
  }
  if (err instanceof GraphNotFoundError) {
    console.error(err.message);
    return EXIT.GAP;
  }
  if (err instanceof ProbeRefused) {
    console.error(err.message);
    return EXIT.PENDING_APPROVAL;
  }
  if (err instanceof GraphValidationError || err instanceof VocabularyError) {
    console.error(err.message);
    return EXIT.ERROR;
  }
  if (err instanceof ZodError) {
    console.error("Invalid input:");
    for (const issue of err.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    return EXIT.ERROR;
  }
  console.error(err instanceof Error ? err.message : String(err));
  return EXIT.ERROR;
}
