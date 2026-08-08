# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [0.1.2] - 2026-08-08

### Fixed

- `wgraph analyze` no longer silently discards every page it visits while
  searching the entry page's links for the one with a repeating list. Each
  visited candidate is now recorded as a page node, with a nav edge back to
  the entry page when the link into it could be pinned down, whether or not
  it turns out to be the overview page — so the crawl budget spent on those
  visits is no longer wasted. (closes #4)

## [0.1.1] - 2026-08-07

### Fixed

- `wgraph observe`/`wgraph learn` no longer misclassify a page as a form page just because it contains hidden forms, such as popup/modal application forms (e.g. Elementor-style "Apply Now" dialogs) that only render once a button is clicked. Form and input counts used for classification now only count elements that are actually visible on the page, so a careers or landing page with hidden popup forms is classified by its visible content instead of being marked `type: 'form'` at `high` confidence.

## [0.1.0] - Initial release
