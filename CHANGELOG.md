# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- The crawler now detects card/item grids whose items are split across multiple
  row-wrapper containers instead of sharing one direct parent, and grids built by
  page-builder tools (e.g. Elementor, Webflow, CSS Modules) that assign a unique,
  hash-suffixed CSS class to every element. Previously these layouts could be
  missed entirely, with `wgraph analyze` reporting no repeating list even when one
  was present on the page. (#1)
