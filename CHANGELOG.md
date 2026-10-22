# Changelog

## [Unreleased]

## [0.4.0] - 2026-10-22

- First queries build a local index and set up guidance for detected Claude and Codex installations. Queries refresh day-old indexes, preserve usable cached results offline, and support `--no-refresh` for cached-only reads.
- Operational commands refresh untouched Shelf-owned skills, including legacy templates and remembered custom destinations, while preserving manual edits and unowned files.
- State updates are serialized across processes to prevent scans from overwriting concurrent description or relation changes; scan depth survives refreshes.
- Skill synchronization rejects an explicitly empty destination before writing into the working directory.
- Bundled agent guidance describes scan configuration writes alongside index replacement, and the README explains saved scan arguments and empty-root rejection.
- Explicitly empty scan roots fail before current-directory resolution, GitHub requests, or saved-state replacement.
- Description trimming avoids splitting Unicode surrogate pairs at the length limit.
- TOML manifest descriptions decode escaped quotes, Unicode, and whitespace before cleaning, with malformed basic strings falling back to other metadata.
- Release-note extraction preserves fenced examples and ignores release headings inside fenced preambles.
- GitHub matching ignores owner/repository casing and deduplicates repeated results while preserving local clones, legacy description overrides, and local relations.
- Description parsing skips leading indented code while preserving lightly indented prose and paragraph continuation lines.
- Description parsing skips backtick and tilde fenced examples with matching delimiter rules, preserves adjacent prose, and recognizes a leading UTF-8 signature before fences and frontmatter.
- README discovery skips directories and broken links while preserving links to regular files and sorted precedence.
- Description reads stop at the existing 256 KiB metadata limit before loading file contents, so oversized files retain their description precedence.
- Commands reject flags belonging to other commands before reading or changing saved state or starting a scan.
- Skill sync refuses linked or nonregular Shelf directories, ownership markers, and skill files before reading or writing through them.
- Saved configuration and index writes remove their own temporary staging after success or failure without touching unrelated temporary files.
- Replacing saved configuration or index files preserves their existing permissions.
- Release-note extraction rejects empty changelog sections before publication.
- Repository scans reject blank explicit depth values before replacing saved configuration or index data.
- Release packaging restores the previous archive if checksum promotion fails and retains recovery files if restoration also fails.
- Release packaging preserves previous archives and checksums when archive or checksum creation fails.
- Release packaging removes its temporary staging directory after success or failure.
- Repository scans include legacy `.saggar/commands.md` catalogs in `agent_files`, alongside `.clip/commands.md`.

## [0.3.0] - 2026-09-27

- `shelf search` now searches declared and machine-local relation explanations, returning both indexed endpoints for resolved relations.
- Local relation overrides replace stale repository-declared explanations in search immediately; unresolved declared relations remain attached to the declaring repository.

## [0.2.0] - 2026-09-25

- Related repositories: declare them in a repository's `.shelf.json`, or record your own with `shelf relate`. `shelf related` and `shelf show` list them in both directions.
- A fork whose origin is upstream matches its GitHub repository through its other remotes, instead of appearing twice. `shelf show` lists every remote.
- Search matches plurals and simple variants, so `clipboards` finds a clipboard manager.
- Repositories without a README take their description from `AGENTS.md` or `CLAUDE.md`.
- `shelf <command> --help` and `shelf help <command>` describe just that command.

## [0.1.1] - 2026-09-25

- Fix the Homebrew install: the release archive's `dist/main.js` is now executable.

## [0.1.0] - 2026-09-25

- Index local repositories and GitHub owners with a one-line description of each.
- `search`, `show`, `list`, and `describe` commands, with JSON output when piped.
- `shelf sync` installs a global agent skill.
- Homebrew formula in `mcclowes/homebrew-shelf`.
