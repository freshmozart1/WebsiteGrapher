# WebsiteGrapher

Learns how a website is **built and navigated**, once, and answers questions about it from a stored graph — without opening a browser again.

It does not extract content. The graph holds pages, components, actions and field _positions_. Not a single price or product name goes into it, and a test asserts that.

```
$ wgraph analyze https://books.toscrape.com
  entry / -> overview (20 repeating items, each linking somewhere)
  pagination: next
  detail /catalogue/:slug/index.html -> detail from 2 samples
  field price at … > p:nth-of-type(1) (its own text is a currency amount, verified)

$ wgraph ask books.toscrape.com "How do I find the price of a product?"
1. Click an item in the list to reach the detail page
2. The price is on the detail page at `… > div:nth-of-type(2) > p:nth-of-type(1)`.
```

The second command opens no browser.

## Install

```bash
./scripts/install-agent.sh
```

Builds the CLI, writes a launcher to `~/.claude/bin/wgraph`, and links the `website-grapher` subagent into `~/.claude/agents/`. Add `~/.claude/bin` to your PATH to use `wgraph` directly.

## How it fits together

Five parts, each usable and testable alone. Data flows one way.

```
Playwright ──► Analyzer ──► PageObservation ──► your judgment ──► Graph ──► Planner ──► Plan
```

- `src/browser/` — owns Playwright. A browser per command; session state (URL, cookies) persists on disk, not a live process.
- `src/analyzer/` — pure observation: normalized elements, repetition clusters, fingerprints, DOM diffs, risk tiers. Never writes the graph.
- `src/graph/` — schema, store, validated mutation, query. Never touches Playwright.
- `src/planner/` — a pure function `(graph, target) → plan`. No I/O at all.
- `src/cli/` — the only place these meet.

**Code observes; judgment names.** The analyzer counts, clusters and diffs. Deciding that a page is a checkout step, or that a `<p>` is a rating, is the agent's job — `wgraph observe <url> --json` hands it everything mechanical with no decision taken.

## Open vocabularies

Page types, component types and field names are open strings backed by a registry inside each graph. Five page types, six component types and four field names are seeded; a site registers more when it needs them:

```bash
wgraph graph add-type shop.example page checkout-step --description "One step of a multi-step purchase flow"
```

Validation rejects any value not in the registry, so a typo fails loudly instead of quietly creating `product-list` alongside `productList`. Nothing in the planner branches on a type string — it starts from `entryPageId` and weights edges by action — so adding a type can never break planning.

## Safety

Learning has to click things to find out what they do. It won't click everything:

- **Blocked**: buy / checkout / delete / log out / unsubscribe labels, anything inside a POST form, password and payment inputs, cross-origin links, non-interactive roles.
- **Needs approval**: buttons whose effect isn't obvious from their label. Learning stops with exit code 3 and lists them; `wgraph resume <domain> --approve <ids>` continues.
- **Free**: same-origin links, checkboxes, radios, selects, search boxes, and controls labelled like list controls.

Budgets cap pages, probes and wall-clock; `robots.txt` is honoured; every run uses a throwaway browser profile.

## Commands

|                                             |                                               |
| ------------------------------------------- | --------------------------------------------- |
| `wgraph analyze <url>`                      | Learn a site (opens a browser)                |
| `wgraph resume <domain> --approve <ids>`    | Continue after approving probes               |
| `wgraph observe <url> --json --fields`      | One page, fully described, no decisions taken |
| `wgraph ask <domain> "<question>"`          | Answer from the graph                         |
| `wgraph plan <domain> --field <name>`       | Route to a named field                        |
| `wgraph graph show <domain> [--vocabulary]` | Inspect what was learned                      |
| `wgraph graph validate <domain>`            | Check the graph is sound                      |
| `wgraph graph apply <domain> --file -`      | Apply a JSON patch                            |

Every command and subcommand accepts `-h` / `--help`. `wgraph graph apply --help` prints the full JSON patch schema with an annotated example — that's the reference for what a patch may contain.

Exit codes: `0` ok, `1` error, `2` nothing learned that answers this, `3` approvals pending.

Graphs live in `~/.claude/website-graphs/<domain>.json` — readable, diffable, hand-editable. Override with `WGRAPH_HOME`.

## Tests

```bash
npm test
```

Unit tests cover the schema, store, planner, diff classification and risk tiering. Integration tests drive a real browser against a fixture site in `test/fixtures/site/` that contains every structure the analyzer must recognise — three pagination modes, a POST form, destructive controls, and detail pages whose fields none of the four builtin names cover. One test runs with the accessibility tree forcibly disabled, proving nothing depends on it.
