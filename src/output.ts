/**
 * ---
 * purpose: Shape command results for agents (paged JSON) and people (text).
 * ---
 */
import { contract } from './contract.ts';

export function page<T>(items: T[], limit: number) {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

export const renderVersion = () => `shelf ${contract.version}`;

export function renderText(result: any): string {
  if (result === contract) return renderHelp();
  if (result.command?.args) return renderCommandHelp(result.command);
  if (Array.isArray(result.items)) return renderItems(result);
  if (typeof result.github_only === 'number') return renderScan(result);
  if ('described' in result) return [result.description ? `Described ${result.described}` : `Cleared override for ${result.described}`, result.next].filter(Boolean).join('\n');
  if (typeof result.cleared === 'string') return `Removed local relation from ${result.cleared} to ${result.to}`;
  if (typeof result.related === 'string') return `Related ${result.related} to ${result.to}`;
  if (typeof result.file === 'string') return `${result.changed ? 'Wrote' : 'Unchanged'} ${result.file}`;
  if (typeof result.id === 'string') return renderRepo(result);
  return JSON.stringify(result, null, 2);
}

type HelpArg = { name: string; required: boolean; type: string; description: string };
type HelpCommand = { name: string; description: string; args: HelpArg[] };

function usage(command: HelpCommand): string {
  const argUsage = (arg: HelpArg) => {
    const value = arg.name.startsWith('--') ? (arg.type === 'boolean' ? arg.name : `${arg.name} <${arg.name.slice(2)}>`) : `<${arg.name}>`;
    return arg.required ? value : `[${value}]`;
  };
  return `shelf ${[command.name, ...command.args.map(argUsage)].join(' ')}`;
}

function renderHelp(): string {
  return [
    `Shelf ${contract.version} — ${contract.description}`, '',
    ...contract.commands.map(command => `  ${usage(command)}\n    ${command.description}`),
    '', 'Options: --output auto|json|text, --limit 100, --help, --version',
  ].join('\n');
}

function renderCommandHelp(command: HelpCommand): string {
  return [usage(command), '', command.description, ...(command.args.length ? ['', ...command.args.map(arg => `  ${arg.name}\t${arg.description}`)] : [])].join('\n');
}

function renderItems(result: any): string {
  const lines = result.items.map((item: any) => item.direction ? relatedLine(item) : `${item.name}\t${item.description ?? '(no description)'}\t${item.path ?? item.remote ?? ''}`);
  if (!lines.length) lines.push('No results.');
  if (result.truncated) lines.push(`Showing ${result.items.length} of ${result.total}; increase --limit for more.`);
  return lines.join('\n');
}

const arrows = { outgoing: '→', incoming: '←' } as const;

function relatedLine(item: any): string {
  const target = item.name ?? `${item.ref} (not indexed)`;
  return `${arrows[item.direction as keyof typeof arrows]} ${target}\t${item.relation ?? '(no relation given)'}\t${item.source}\t${item.path ?? item.remote ?? ''}`;
}

function renderScan(result: any): string {
  return [
    `Indexed ${result.total} repositories: ${result.local} local, ${result.github_only} on GitHub only, ${result.undescribed} undescribed.`,
    `Roots: ${result.roots.join(', ')}`,
    ...(result.github.length ? [`GitHub: ${result.github.join(', ')}`] : []),
    ...(result.truncated ? ['Stopped early at the directory limit; narrow --root or lower --depth.'] : []),
    ...(result.warnings ?? []).map((warning: string) => `Warning: ${warning}`),
  ].join('\n');
}

function renderRepo(repo: any): string {
  const rows: [string, unknown][] = [
    ['description', repo.description && `${repo.description} (${repo.description_source})`],
    ['path', repo.path], ['remote', repo.remote], ['branch', repo.branch], ['language', repo.language],
    ['topics', repo.topics?.join(', ')], ['agent files', repo.agent_files?.join(', ')], ['manifests', repo.manifests?.join(', ')],
    ['last activity', repo.last_activity ?? repo.github?.pushed_at],
    ['github', repo.github && [repo.github.url, repo.github.private && 'private', repo.github.archived && 'archived', repo.github.fork && 'fork'].filter(Boolean).join(' ')],
  ];
  const related = (repo.related ?? []).map((item: any) => `    ${relatedLine(item)}`);
  return [repo.name, ...rows.filter(([, value]) => value).map(([key, value]) => `  ${key}: ${value}`), ...(related.length ? ['  related:', ...related] : [])].join('\n');
}
