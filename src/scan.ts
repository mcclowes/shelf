/**
 * ---
 * purpose: Find Git repositories under configured roots with a bounded walk, and read their metadata from .git files directly.
 * ---
 */
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { agentFileNames, describeLocal, manifestNames, presentFiles } from './describe.ts';
import type { Repo } from './store.ts';

export const defaultDepth = 4;
export const maxDirectories = 50_000;
/** Dependency and build directories never hold the user's own projects, and are often huge. */
const skippedDirs = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'Pods', 'DerivedData', 'Library', 'Applications']);

/** Only directories with a .git directory count; worktrees and submodules have a .git file and are skipped. */
export function findRepositories(roots: string[], depth = defaultDepth): { paths: string[]; truncated: boolean } {
  const found = new Set<string>();
  const queue = roots.map(root => ({ dir: resolve(root), level: 0 }));
  let visited = 0;
  for (let next = queue.shift(); next; next = queue.shift()) {
    if (++visited > maxDirectories) return { paths: [...found], truncated: true };
    let entries: Dirent[];
    try {
      entries = readdirSync(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some(entry => entry.name === '.git' && entry.isDirectory())) {
      found.add(next.dir);
      continue;
    }
    if (next.level >= depth) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !skippedDirs.has(entry.name)) queue.push({ dir: join(next.dir, entry.name), level: next.level + 1 });
    }
  }
  return { paths: [...found], truncated: false };
}

export function readLocalRepo(path: string): Repo {
  const git = join(path, '.git');
  return {
    id: path, name: basename(path), path, ...describeLocal(path),
    remote: readRemote(join(git, 'config')), branch: readBranch(join(git, 'HEAD')), last_activity: lastActivity(git),
    agent_files: presentFiles(path, agentFileNames), manifests: presentFiles(path, manifestNames),
  };
}

/** Prefer origin; otherwise the first remote with a URL. */
function readRemote(configFile: string): string | undefined {
  const text = readOptional(configFile);
  if (!text) return undefined;
  const remotes = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const section = line.match(/^\s*\[remote "([^"]+)"\]/);
    if (section) current = section[1];
    else if (/^\s*\[/.test(line)) current = undefined;
    else if (current && !remotes.has(current)) {
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (url) remotes.set(current, url[1]);
    }
  }
  const url = remotes.get('origin') ?? remotes.values().next().value;
  return url ? normalizeRemote(url) : undefined;
}

/** `git@github.com:acme/app.git`, `https://github.com/acme/app`, and `ssh://git@github.com/acme/app.git` all become `github.com/acme/app`. */
export function normalizeRemote(url: string): string | undefined {
  const match = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/i);
  if (!match || url.startsWith('/') || url.startsWith('.') || url.startsWith('file:')) return undefined;
  return `${match[1].toLowerCase()}/${match[2]}`;
}

function readBranch(headFile: string): string | undefined {
  return readOptional(headFile)?.match(/^ref: refs\/heads\/(.+)$/m)?.[1].trim();
}

/** The reflog changes on commit, checkout, and pull, so its mtime tracks recent work without running git. */
function lastActivity(git: string): string | undefined {
  for (const file of [join(git, 'logs', 'HEAD'), join(git, 'HEAD')]) {
    try {
      return statSync(file).mtime.toISOString();
    } catch {}
  }
  return undefined;
}

function readOptional(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}
