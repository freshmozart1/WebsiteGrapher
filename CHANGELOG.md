# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.3.0] - 2026-08-08

### Added

- Page nodes can now be marked `overlay: true` to represent an in-page dialog, drawer or popup that has no URL of its own, reachable through the existing edge and planner machinery unchanged. (closes #3)

## [0.2.1] - 2026-08-08

### Fixed

- `wgraph analyze` no longer silently discards every page it visits while
  searching the entry page's links for the one with a repeating list. Each
  visited candidate is now recorded as a page node, with a nav edge back to
  the entry page when the link into it could be pinned down, whether or not
  it turns out to be the overview page — so the crawl budget spent on those
  visits is no longer wasted. (closes #4)

## [0.2.0] - 2026-08-08

### Added

- `-h` / `--help` now works on every CLI command and subcommand. Previously
  `--help` crashed with `Unknown option '--help'`, because `parseArgs` runs in
  strict mode and rejects any flag a command doesn't declare (closes #5).
- `wgraph graph apply --help` documents the full JSON patch schema, with a
  fully annotated example of every patch field.

## [0.1.2] - 2026-08-08

### Fixed

- The crawler now detects card/item grids whose items are split across multiple
  row-wrapper containers instead of sharing one direct parent, and grids built by
  page-builder tools (e.g. Elementor, Webflow, CSS Modules) that assign a unique,
  hash-suffixed CSS class to every element. Previously these layouts could be
  missed entirely, with `wgraph analyze` reporting no repeating list even when one
  was present on the page. (#1)

## [0.1.1] - 2026-08-07

### Fixed

- `wgraph observe`/`wgraph learn` no longer misclassify a page as a form page just because it contains hidden forms, such as popup/modal application forms (e.g. Elementor-style "Apply Now" dialogs) that only render once a button is clicked. Form and input counts used for classification now only count elements that are actually visible on the page, so a careers or landing page with hidden popup forms is classified by its visible content instead of being marked `type: 'form'` at `high` confidence.

## [0.1.0] - Initial release
