/**
 * ---
 * purpose: Shape command results for agents (paged JSON) and render each kind of result as text for people.
 * related:
 *   - ./commands.ts - Pairs each command with the renderer for its result.
 * ---
 */
import { contract } from './contract.ts';
import type { RelatedItem } from './relations.ts';
import type { summary } from './repos.ts';
import type { Repo } from './store.ts';

type Paged<T> = { items: T[]; total: number; truncated: boolean };
type ListItem = ReturnType<typeof summary>;
type ShownRepo = Omit<Repo, 'related'> & { related: RelatedItem[] };
type ScanSummary = { total: number; local: number; github_only: number; undescribed: number; roots: string[]; github: string[]; truncated: boolean; warnings?: string[] };
type HelpArg = { name: string; required: boolean; type: string; description: string };
type HelpCommand = { name: string; description: string; args: HelpArg[] };

export function page<T>(items: T[], limit: number): Paged<T> {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

export const renderVersion = () => `shelf ${contract.version}`;

function usage(command: HelpCommand): string {
  const argUsage = (arg: HelpArg) => {
    const value = arg.name.startsWith('--') ? (arg.type === 'boolean' ? arg.name : `${arg.name} <${arg.name.slice(2)}>`) : `<${arg.name}>`;
    return arg.required ? value : `[${value}]`;
  };
  return `shelf ${[command.name, ...command.args.map(argUsage)].join(' ')}`;
}

export function renderHelp(): string {
  return [
    `Shelf ${contract.version} — ${contract.description}`, '',
    ...contract.commands.map(command => `  ${usage(command)}\n    ${command.description}`),
    '', 'Options: --output auto|json|text, --limit 100, --help, --version',
  ].join('\n');
}

export function renderCommandHelp({ command }: { command: HelpCommand }): string {
  return [usage(command), '', command.description, ...(command.args.length ? ['', ...command.args.map(arg => `  ${arg.name}\t${arg.description}`)] : [])].join('\n');
}

export function renderItems(result: Paged<ListItem | RelatedItem>): string {
  const lines = result.items.map(item => 'direction' in item ? relatedLine(item) : `${item.name}\t${item.description ?? '(no description)'}\t${item.path ?? item.remote ?? ''}`);
  if (!lines.length) lines.push('No results.');
  if (result.truncated) lines.push(`Showing ${result.items.length} of ${result.total}; increase --limit for more.`);
  return lines.join('\n');
}

const arrows = { outgoing: '→', incoming: '←' } as const;

function relatedLine(item: RelatedItem): string {
  const target = item.name ?? `${item.ref} (not indexed)`;
  return `${arrows[item.direction]} ${target}\t${item.relation ?? '(no relation given)'}\t${item.source}\t${item.path ?? item.remote ?? ''}`;
}

export function renderScan(result: ScanSummary): string {
  return [
    `Indexed ${result.total} repositories: ${result.local} local, ${result.github_only} on GitHub only, ${result.undescribed} undescribed.`,
    `Roots: ${result.roots.join(', ')}`,
    ...(result.github.length ? [`GitHub: ${result.github.join(', ')}`] : []),
    ...(result.truncated ? ['Stopped early at the directory limit; narrow --root or lower --depth.'] : []),
    ...(result.warnings ?? []).map(warning => `Warning: ${warning}`),
  ].join('\n');
}

export function renderDescribed(result: { described: string; description: string | null; next?: string }): string {
  return [result.description ? `Described ${result.described}` : `Cleared override for ${result.described}`, result.next].filter(Boolean).join('\n');
}

export function renderRelation(result: { cleared: string; to: string } | { related: string; to: string }): string {
  return 'cleared' in result ? `Removed local relation from ${result.cleared} to ${result.to}` : `Related ${result.related} to ${result.to}`;
}

export const renderSync = (result: { file: string; changed: boolean }) => `${result.changed ? 'Wrote' : 'Unchanged'} ${result.file}`;

export function renderRepo(repo: ShownRepo): string {
  const rows: [string, unknown][] = [
    ['description', repo.description && `${repo.description} (${repo.description_source})`],
    ['path', repo.path], ['remote', repo.remote], ['branch', repo.branch], ['language', repo.language],
    ['topics', repo.topics?.join(', ')], ['agent files', repo.agent_files?.join(', ')], ['manifests', repo.manifests?.join(', ')],
    ['last activity', repo.last_activity ?? repo.github?.pushed_at],
    ['github', repo.github && [repo.github.url, repo.github.private && 'private', repo.github.archived && 'archived', repo.github.fork && 'fork'].filter(Boolean).join(' ')],
  ];
  const related = repo.related.map(item => `    ${relatedLine(item)}`);
  return [repo.name, ...rows.filter(([, value]) => value).map(([key, value]) => `  ${key}: ${value}`), ...(related.length ? ['  related:', ...related] : [])].join('\n');
}
