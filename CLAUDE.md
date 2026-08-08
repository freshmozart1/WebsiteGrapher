# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — compile with `tsc -p tsconfig.json`
- `npm run wgraph -- <args>` — run the CLI straight from TS source via `tsx` (e.g. `npm run wgraph -- analyze https://example.com`)
- `npm test` — full suite (unit + integration; integration drives a real Playwright browser against a local fixture server, so it's slower)
- `npm run test:unit` — unit tests only, fast
- `npm run typecheck` — `tsc --noEmit`
- Run a single test: `npx vitest run <path>` or `npx vitest run -t "<name>"`
- `npm run lint` — ESLint (flat config in `eslint.config.js`, `typescript-eslint` recommended rules)

## Architecture

Five layers, data flows one way, each testable alone:

```
Playwright ──► Analyzer ──► PageObservation ──► (judgment) ──► Graph ──► Planner ──► Plan
```

- `src/browser/` — owns Playwright only.
- `src/analyzer/` — pure observation (normalized elements, repetition clusters, fingerprints, DOM diffs, risk tiers). Never writes the graph.
- `src/graph/` — schema, store, validated mutation, query. Never touches Playwright.
- `src/planner/` — a pure function `(graph, target) → plan`. No I/O at all.
- `src/cli/` — the only layer allowed to touch more than one of the above.

Keep new code inside the layer matching this contract — e.g. don't add I/O to `planner/`, don't have `analyzer/` write to the graph directly.

## Code style

- TypeScript strict mode plus `noUncheckedIndexedAccess` and `noImplicitOverride` (`tsconfig.json`).
- Module resolution is `NodeNext`: relative imports must include the `.js` extension even though source files are `.ts` (e.g. `import { x } from './schema.js'`).
- Formatting: 4-space indent, single quotes, semicolons (`.prettierrc`). Prettier isn't a project dependency and there's no format script — formatting is applied by editor integration or hook, not an npm script.
- Comments explain *why*, not *what* — existing source rarely comments obvious code.

## Testing

- vitest; tests live in `test/unit/` and `test/integration/`.
- Integration tests boot a real Playwright browser against a fixture site (`test/fixtures/site/`) — expect each to take several seconds.
- Graph fixtures live in `test/helpers/graphs.ts`; reuse them rather than hand-building graph objects.

## Domain rules (easy to violate by accident)

- The graph stores structure only, never page content — no prices, names, or other scraped values in a patch or fixture. A test enforces this.
- Locators for fields must be structural (`role`/`label`/`placeholder`/`css`/`xpath`) — never `text` or `name`, which pin to one instance's displayed value.
- Page/component/field type names are open vocabularies but must be registered and kebab-case; validation rejects anything unregistered.
- Graphs are stored at `~/.claude/website-graphs/<domain>.json` (override with `WGRAPH_HOME`).

## Repo notes

- No CI workflow exists — `npm run typecheck && npm run lint && npm test` is the only regression check before a commit.
- `agent/website-grapher.md` is the subagent definition; `./scripts/install-agent.sh` symlinks it into `~/.claude/agents/`, so edits take effect without reinstalling.
