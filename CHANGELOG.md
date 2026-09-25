# Changelog

## [Unreleased]

- Related repositories: declare them in a repository's `.shelf.json`, or record your own with `shelf relate`. `shelf related` and `shelf show` list them in both directions.

## [0.1.1] - 2026-09-25

- Fix the Homebrew install: the release archive's `dist/main.js` is now executable.

## [0.1.0] - 2026-09-25

- Index local repositories and GitHub owners with a one-line description of each.
- `search`, `show`, `list`, and `describe` commands, with JSON output when piped.
- `shelf sync` installs a global agent skill.
- Homebrew formula in `mcclowes/homebrew-shelf`.
