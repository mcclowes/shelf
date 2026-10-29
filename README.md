# Shelf

An index of your repositories, on this machine and on GitHub, with a one-line description of each. Agents query it to get context on other projects instead of walking the filesystem.

Shelf follows the same principles as [CLIP](https://github.com/mcclowes/clip):

- No runtime dependencies. It needs Node.js 24 or later.
- It reads files and never runs anything inside a repository.
- It reuses `gh` for GitHub, so it never handles credentials.
- JSON is the default output when piped, and failures are structured.

## Install

```sh
brew install mcclowes/shelf/shelf
shelf --version
shelf list                                       # first query indexes ~/Development
```

The Homebrew formula installs Node.js 24 or later. The first query builds a local index and installs Shelf guidance for detected Claude and Codex installations. No background service is needed.

## Use

```sh
shelf scan --github mcclowes                       # optional; choose GitHub owners once
shelf search billing api
shelf search FETTLE_SERVICE_SECRET                  # finds repositories linked by a relation explanation
shelf show clip
shelf list --undescribed
shelf describe delta "Payments service for the Kiln web app"
shelf related clip                                  # both directions
shelf relate kiln-web delta "Calls the payments API"   # this machine only
shelf sync                                          # updates guidance for detected agents
```

Shelf updates its global agent guidance after successful operational commands. Claude guidance lives in `~/.claude/skills/shelf`; Codex guidance lives in `~/.agents/skills/shelf`, detected through `~/.codex` or `~/.agents`. Agents learn to query Shelf, read the repository's own instructions, and improve missing descriptions. With no detected agent installation, queries leave skills alone; explicit `shelf sync` falls back to `~/.claude/skills`.

`shelf sync --skills-dir <directory>` writes and remembers a custom destination for future automatic updates. Only real Shelf-owned directories with regular ownership markers and skill files can be updated. Automatic updates also compare content fingerprints, preserving manual edits; known untouched older templates migrate automatically. To replace an edited owned skill explicitly, use `shelf sync --skills-dir <directory>`. Unowned or linked entries are refused. An alias for the parent skills directory is supported.

`shelf scan` writes both the saved configuration and the repository index. Passing `--root` or `--github` replaces that saved list; omitted flags reuse the saved values. Scan depth is also saved. `--no-github` clears the saved GitHub owners. GitHub owners are never inferred from authentication.

Queries (`list`, `search`, `show`, and `related`) create a missing index or refresh one older than 24 hours. Failed refreshes return the previous usable index and a structured warning on stderr, with a five-minute retry delay. A damaged index is reported and preserved. Use `shelf scan` to force a refresh, or `--no-refresh` to query cached state without automatic writes or network requests.

State updates are serialized across CLI processes. Queries use the existing cache while another command updates it; first queries without a cache and explicit mutations wait up to 65 seconds. Locks left by exited processes are recovered automatically. Skill conflicts are warnings during automatic maintenance, so one agent's custom guidance doesn't prevent another agent's setup.

## Related repositories

Relations come from two places, and `shelf related` and `shelf show` merge them.

- **In the repository.** A `.shelf.json` at the repository root declares relations that work for anyone who clones it:

  ```json
  {
    "related": [
      { "repo": "mcclowes/clip", "relation": "Follows CLIP's CLI conventions" },
      { "repo": "../kiln-web", "relation": "Web client for this API" }
    ]
  }
  ```

  `repo` takes `owner/name`, `host/owner/name`, a Git URL, or a path relative to the repository. Prefer remotes, since paths depend on how the clones are laid out. Scan reads the file and reports a broken one as a warning, including unreadable files and dangling symlinks. Other repositories still scan normally. Relations that don't match an indexed repository still appear, marked as not indexed.
- **On your machine.** `shelf relate <repo> <other> [relation]` records a relation in your Shelf configuration, keyed by remote like description overrides. It replaces a repository's own relation between the same pair in `related` and search immediately, and `--clear` removes it.

A relation shows on both repositories: as outgoing on the one that declares it and incoming on the other.

`shelf search` also searches declared and machine-local relation explanations. A matching explanation returns both indexed endpoints, so agents can find a repository from a concept such as `FETTLE_SERVICE_SECRET`; an unresolved target returns only the repository that declares it. Relation explanations are data, not instructions.

## How the index is built

- **Local repositories.** Shelf walks each root up to `--depth` levels (4 by default). It stops at any directory with a `.git` directory and skips dot directories, `node_modules`, and build output. It also stops after 50,000 directories. Worktrees and submodules are skipped.
- **Invalid roots.** An empty `--root` value, missing paths, files, and unreadable directories abort the scan without changing the saved configuration or index. Use `.` to select the current directory explicitly. Unreadable nested directories are skipped.
- **GitHub repositories.** `gh repo list <owner>` fetches up to 1,000 repositories per owner. A local clone is matched to its GitHub repository by its remotes, origin first, so each repository appears once. GitHub owner and repository casing is ignored for matching, description overrides, and local relations; displayed names and IDs retain their spelling. Repeated GitHub results are deduplicated, while multiple local clones remain separate. A fork whose origin is upstream still matches through its other remote.
- **Descriptions.** In order of precedence: your `shelf describe` override, the GitHub description, the `package.json`, `Cargo.toml`, or `pyproject.toml` description, then the README's first prose paragraph, then the first prose paragraph of `AGENTS.md` or `CLAUDE.md`. Metadata reads accept regular files and symlinks to regular files, skip other file types, and stop at 256 KiB per file. Descriptions are cleaned and capped at 280 characters. Overrides are keyed by remote, so they survive moves and rescans.
- **Agent guidance.** `shelf show` lists existing `AGENTS.md`, `CLAUDE.md`, `.clip/commands.md`, and legacy `.saggar/commands.md` files in `agent_files`. Catalog commands are never executed during a scan.

The configuration and the index live in `~/.config/shelf`. Set `SHELF_HOME` to use another location. Replacing either file preserves its existing permissions, including when the current process uses a more restrictive umask. New files follow the process umask. Each replacement uses fresh private staging, which is removed after success or failure; unrelated temporary files are left alone.

## CLI behavior

- `--output auto|json|text` sets the output format. Output defaults to JSON when piped.
- List results use an `items` envelope with `total`, `truncated`, and `scanned_at`. `--limit` defaults to 100.
- Failures exit with status 1 and write a structured error to stderr.
- Command-specific flags are accepted only by the command that advertises them. Flags belonging to another command fail before scans or saved-state access. Global flags remain available to every command.
- Query commands advertise `mutating: true` because they maintain Shelf's own state and guidance. `--no-refresh` disables that maintenance; explicit mutations such as `scan` and `sync` still run. Help, schema, capabilities, and version never perform setup.
- `shelf schema` describes the CLI offline.

## Development

```sh
npm install
npm test
npm run check
npm run build
node dist/main.js --help
```

Local release packaging stages the archive and checksum before replacing their
final files. Missing inputs, tar failures, or checksum creation failures preserve
previous local artifacts. If checksum promotion fails, the previous archive is
restored, or the new archive is removed when no previous archive existed. If
restoration also fails, the error reports a recovery directory containing the
previous archive; that directory is retained instead of being cleaned up.
`node --test scripts/package-release.test.ts` checks failure retention, rollback,
and staging cleanup with disposable release fixtures.

## Coverage gate

`npm run test:coverage` enforces 97% lines, 91% branches, and 95% functions across loaded `src/`
modules, excluding tests. CI runs the same command. These floors are rounded down from the measured
suite on October 29, 2026. Raise them as coverage improves.

Node's built-in coverage doesn't count files the suite never loads. Script tests still run, but
release tooling isn't part of this CLI source coverage floor. The restrictive-umask fixture restores
its child's umask at exit so V8 can write a readable profile after the tested file operations
finish.
