/**
 * ---
 * purpose: Read relations a repository declares in .shelf.json, and resolve declared and machine-local relations in both directions.
 * related:
 *   - ./store.ts - Stores declared relations on index entries and local relations in the configuration.
 * ---
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { clean } from './describe.ts';
import { findRepos, summary } from './repos.ts';
import { normalizeRemote } from './scan.ts';
import { overrideKey, type DeclaredRelation, type LocalRelation, type Repo } from './store.ts';

export const relationsFile = '.shelf.json';

/** A missing file is normal; a broken one is reported so scan can warn without failing. */
export function readDeclaredRelations(path: string): { related?: DeclaredRelation[]; warnings: string[] } {
  const file = join(path, relationsFile);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { warnings: [] };
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { warnings: [`${file} is not valid JSON.`] };
  }
  if (!Array.isArray(data?.related)) return { warnings: [`${file} needs a "related" array.`] };
  const warnings: string[] = [];
  const related: DeclaredRelation[] = [];
  for (const [position, entry] of data.related.entries()) {
    const ref = typeof entry?.repo === 'string' ? entry.repo.trim() : '';
    if (!ref) {
      warnings.push(`${file} related[${position}] needs a "repo".`);
      continue;
    }
    const relation = typeof entry.relation === 'string' ? clean(entry.relation) : undefined;
    related.push({ ref, ...(relation ? { relation } : {}) });
  }
  return { related, warnings };
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
  const byKey = (key: string) => repos.filter(repo => overrideKey(repo) === key);
  const declared = repos.flatMap(from => (from.related ?? []).map(({ ref, relation }) => ({ from, ref, targets: resolveRef(repos, from, ref), relation, source: 'repo' as const })));
  const mine = local.flatMap(({ from, to, relation }) => byKey(from).map(repo => ({ from: repo, ref: to, targets: byKey(to), relation, source: 'local' as const })));
  return [...mine, ...declared];
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
