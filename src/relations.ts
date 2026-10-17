/**
 * ---
 * purpose: Read relations a repository declares in .shelf.json, and resolve declared and machine-local relations in both directions.
 * related:
 *   - ./store.ts - Stores declared relations on index entries and local relations in the configuration.
 * ---
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { clean } from './describe.ts';
import { findRepos, summary } from './repos.ts';
import { normalizeRemote } from './scan.ts';
import { identityKey, overrideKey, type DeclaredRelation, type LocalRelation, type Repo } from './store.ts';

export const relationsFile = '.shelf.json';

/** A missing file is normal; a broken one is reported so scan can warn without failing. */
export function readDeclaredRelations(path: string): { related?: DeclaredRelation[]; warnings: string[] } {
  const file = join(path, relationsFile);
  let text: string;
  try {
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(descriptor).isFile()) return { warnings: [`${file} is not a regular file.`] };
      text = readFileSync(descriptor, 'utf8');
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (asObject(error)?.code === 'ENOENT' && isAbsent(file)) return { warnings: [] };
    return { warnings: [`${file} could not be read: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { warnings: [`${file} is not valid JSON.`] };
  }
  const entries = asObject(data)?.related;
  if (!Array.isArray(entries)) return { warnings: [`${file} needs a "related" array.`] };
  const warnings: string[] = [];
  const related: DeclaredRelation[] = [];
  for (const [position, value] of (entries as unknown[]).entries()) {
    const entry = asObject(value);
    const ref = typeof entry?.repo === 'string' ? entry.repo.trim() : '';
    if (!ref) {
      warnings.push(`${file} related[${position}] needs a "repo".`);
      continue;
    }
    const relation = typeof entry?.relation === 'string' ? clean(entry.relation) : undefined;
    related.push({ ref, ...(relation ? { relation } : {}) });
  }
  return { related, warnings };
}

function isAbsent(file: string): boolean {
  try {
    return lstatSync(file, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

type Source = 'repo' | 'local';
type Direction = 'outgoing' | 'incoming';
type Edge = { from: Repo; ref: string; targets: Repo[]; relation?: string; source: Source };
type Summary = { [K in keyof ReturnType<typeof summary>]: ReturnType<typeof summary>[K] | null };
export type RelatedItem = Summary & { ref: string; relation: string | null; direction: Direction; source: Source };

/** Paths resolve against the declaring clone; URLs and `host/owner/name` match remotes; anything else matches like `shelf show`. */
export function resolveRef(repos: Repo[], from: Repo, ref: string): Repo[] {
  if (ref.startsWith('.') || isAbsolute(ref)) {
    if (!from.path) return [];
    const path = resolve(from.path, ref);
    return repos.filter(repo => repo.path === path);
  }
  const remote = /[:@]/.test(ref) ? normalizeRemote(ref) : undefined;
  return findRepos(repos, remote ?? ref);
}

function edges(repos: Repo[], local: LocalRelation[]): Edge[] {
  const byKey = (key: string) => repos.filter(repo => overrideKey(repo) === identityKey(key));
  const declared = repos.flatMap(from => (from.related ?? []).map(({ ref, relation }) => ({ from, ref, targets: resolveRef(repos, from, ref), relation, source: 'repo' as const })));
  const mine = local.flatMap(({ from, to, relation }) => byKey(from).map(repo => ({ from: repo, ref: to, targets: byKey(to), relation, source: 'local' as const })));
  const localPairs = new Set(local.map(({ from, to }) => `${identityKey(from)}\0${identityKey(to)}`));
  const effectiveDeclared = declared.flatMap(edge => {
    const targets = edge.targets.filter(target => !localPairs.has(`${overrideKey(edge.from)}\0${overrideKey(target)}`));
    return targets.length || !edge.targets.length ? [{ ...edge, targets }] : [];
  });
  return [...mine, ...effectiveDeclared];
}

/** Relation explanations are searchable data on each resolved endpoint, or only the declaring repository when unresolved. */
export function searchableRelationText(repos: Repo[], local: LocalRelation[]): Map<string, string[]> {
  const text = new Map<string, string[]>();
  const add = (repo: Repo, relation: string) => text.set(repo.id, [...(text.get(repo.id) ?? []), relation]);
  for (const edge of edges(repos, local)) {
    if (!edge.relation) continue;
    add(edge.from, edge.relation);
    for (const target of edge.targets) add(target, edge.relation);
  }
  return text;
}

/** A local relation replaces a repo-file relation between the same two repositories in the same direction. */
export function relatedTo(repos: Repo[], local: LocalRelation[], repo: Repo): RelatedItem[] {
  const items: RelatedItem[] = [];
  const seen = new Set<string>();
  const add = (direction: Direction, other: Repo | undefined, edge: Edge) => {
    const key = `${direction}\0${other?.id ?? edge.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fields = other ? summary(other) : { id: null, name: null, description: null, path: null, remote: null };
    items.push({ ...fields, ref: edge.ref, relation: edge.relation ?? null, direction, source: edge.source });
  };
  for (const edge of edges(repos, local)) {
    if (edge.from.id === repo.id) {
      if (edge.targets.length) for (const target of edge.targets) add('outgoing', target, edge);
      else add('outgoing', undefined, edge);
    } else if (edge.targets.some(target => target.id === repo.id)) add('incoming', edge.from, edge);
  }
  return items.filter(item => item.id !== repo.id).sort(byDirectionThenName);
}

const directionOrder: Record<Direction, number> = { outgoing: 0, incoming: 1 };

/** Outgoing before incoming, resolved before unresolved, then by name. */
const byDirectionThenName = (a: RelatedItem, b: RelatedItem) =>
  directionOrder[a.direction] - directionOrder[b.direction] || Number(!a.name) - Number(!b.name) || (a.name ?? a.ref).localeCompare(b.name ?? b.ref);
