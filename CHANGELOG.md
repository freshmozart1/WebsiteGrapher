# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-08-08

### Added

- `-h` / `--help` now works on every CLI command and subcommand. Previously
  `--help` crashed with `Unknown option '--help'`, because `parseArgs` runs in
  strict mode and rejects any flag a command doesn't declare (closes #5).
- `wgraph graph apply --help` documents the full JSON patch schema, with a
  fully annotated example of every patch field.

## [0.1.2] - 2026-08-08

### Fixed

- Discount hidden modal forms when classifying a page (closes #2).
- Detect card grids split across row containers (closes #1).

## [0.1.0] - 2026-08-06

### Added

- Initial release: learn a website's structure once by driving a real
  browser, then answer navigation questions from the stored graph without
  opening a browser again.
