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
```

The Homebrew formula installs Node.js 24 or later.

## Use

```sh
shelf scan --root ~/Development --github mcclowes   # saved; later scans reuse them
shelf search billing api
shelf show clip
shelf list --undescribed
shelf describe delta "Payments service for the Kiln web app"
shelf sync                                          # writes ~/.claude/skills/shelf
```

`shelf sync` installs a global skill that tells agents to use `search` and `show`, to read a repository's `AGENTS.md` or README once they have its path, and to fill in missing descriptions.

## How the index is built

- **Local repositories.** Shelf walks each root up to `--depth` levels (4 by default). It stops at any directory with a `.git` directory and skips dot directories, `node_modules`, and build output. It also stops after 50,000 directories. Worktrees and submodules are skipped.
- **GitHub repositories.** `gh repo list <owner>` fetches up to 1,000 repositories per owner. A local clone is matched to its GitHub repository by the origin remote, so each repository appears once.
- **Descriptions.** In order of precedence: your `shelf describe` override, the GitHub description, the `package.json`, `Cargo.toml`, or `pyproject.toml` description, then the README's first prose paragraph. Descriptions are cleaned and capped at 280 characters. Overrides are keyed by remote, so they survive moves and rescans.

The configuration and the index live in `~/.config/shelf`. Set `SHELF_HOME` to use another location.

## CLI behavior

- `--output auto|json|text` sets the output format. Output defaults to JSON when piped.
- List results use an `items` envelope with `total`, `truncated`, and `scanned_at`. `--limit` defaults to 100.
- Failures exit with status 1 and write a structured error to stderr.
- `shelf schema` describes the CLI offline.

## Development

```sh
npm install
npm test
npm run check
npm run build
node dist/main.js --help
```
