/**
 * ---
 * purpose: Merge local clones with GitHub repositories, apply description overrides, and resolve and search index entries.
 * ---
 */
import { resolve } from 'node:path';
import { overrideKey, type Repo } from './store.ts';

/**
 * A clone takes GitHub's description, language, and topics; GitHub repositories without a clone keep their own entry.
 * A fork's origin is often upstream, so any remote can match, and the matched one becomes the clone's remote.
 */
export function mergeRepos(local: Repo[], remote: Repo[], overrides: Record<string, string>): Repo[] {
  const byRemote = new Map(remote.map(repo => [repo.remote, repo]));
  const cloned = new Set<string>();
  const merged = local.map(repo => {
    const github = (repo.remotes ?? [repo.remote]).map(remote => remote && byRemote.get(remote)).find(Boolean);
    if (!github) return repo;
    cloned.add(github.id);
    const { id: _id, name: _name, description, description_source, ...rest } = github;
    return { ...repo, ...rest, ...(description ? { description, description_source } : {}) };
  });
  return [...merged, ...remote.filter(repo => !cloned.has(repo.id))].map(repo => applyOverride(repo, overrides)).sort(byName);
}

export function applyOverride(repo: Repo, overrides: Record<string, string>): Repo {
  const description = overrides[overrideKey(repo)];
  return description ? { ...repo, description, description_source: 'override' } : repo;
}

const byName = (a: Repo, b: Repo) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);

/** Matches an id, a path, `owner/name`, `host/owner/name`, or a bare name, case-insensitively. */
export function findRepos(repos: Repo[], ref: string): Repo[] {
  const exact = repos.filter(repo => repo.id === ref || (repo.path && repo.path === resolve(ref)));
  if (exact.length) return exact;
  const lower = ref.toLowerCase().replace(/\.git$/, '');
  const matchesRemote = (remote: string) => remote === lower || remote.slice(remote.indexOf('/') + 1) === lower;
  return repos.filter(repo => repo.name.toLowerCase() === lower || [repo.remote, ...(repo.remotes ?? [])].some(remote => remote && matchesRemote(remote.toLowerCase())));
}

export function findRepo(repos: Repo[], ref: string): Repo {
  const matches = findRepos(repos, ref);
  if (!matches.length) throw new Error(`No repository matches ${ref}. Try shelf search ${ref}, or rescan with shelf scan.`);
  if (matches.length > 1) throw new Error(`${ref} matches ${matches.length} repositories; use one of these ids: ${matches.map(repo => repo.id).join(', ')}`);
  return matches[0];
}

/** Every query word must appear somewhere; name hits outrank topic, language, and description hits. */
export function searchRepos(repos: Repo[], query: string): Repo[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('Search needs a query.');
  const scored = repos.map(repo => ({ repo, score: score(repo, words) })).filter(result => result.score > 0);
  return scored.sort((a, b) => b.score - a.score || byName(a.repo, b.repo)).map(result => result.repo);
}

function score(repo: Repo, words: string[]): number {
  const name = repo.name.toLowerCase();
  const tags = [...(repo.topics ?? []), repo.language ?? ''].map(tag => tag.toLowerCase());
  const text = `${repo.description ?? ''} ${repo.remote ?? ''} ${repo.path ?? ''}`.toLowerCase();
  const stems = new Set([name, ...tags, text].flatMap(field => field.split(/[^a-z0-9]+/)).map(stem));
  let total = 0;
  for (const word of words) {
    const root = stem(word);
    const inText = text.includes(word) || text.includes(root) || stems.has(root);
    const hit = (name === word ? 100 : name.includes(word) || name.includes(root) ? 50 : 0) + (tags.includes(word) || tags.includes(root) ? 30 : 0) + (inText ? 10 : 0);
    if (!hit) return 0;
    total += hit;
  }
  return total;
}

/** Strips common English suffixes so plurals and -ing forms match their root; enough for repository descriptions. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3).replace(/([^aeiou])\1$/, '$1');
  if (/(s|x|z|ch|sh)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** List and search show enough to choose a repository; show returns the rest. */
export const summary = ({ id, name, description, path, remote }: Repo) => ({ id, name, description: description ?? null, path: path ?? null, remote: remote ?? null });
