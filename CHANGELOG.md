# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-08-06

### Fixed

- `wgraph analyze` no longer silently discards every page it visits while
  searching the entry page's links for the one with a repeating list. Each
  visited candidate is now recorded as a page node, with a nav edge back to
  the entry page when the link into it could be pinned down, whether or not
  it turns out to be the overview page — so the crawl budget spent on those
  visits is no longer wasted. (closes #4)
