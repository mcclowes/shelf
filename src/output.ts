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
  if (Array.isArray(result.items)) return renderItems(result);
  if (typeof result.github_only === 'number') return renderScan(result);
  if ('described' in result) return [result.description ? `Described ${result.described}` : `Cleared override for ${result.described}`, result.next].filter(Boolean).join('\n');
  if (typeof result.file === 'string') return `${result.changed ? 'Wrote' : 'Unchanged'} ${result.file}`;
  if (typeof result.id === 'string') return renderRepo(result);
  return JSON.stringify(result, null, 2);
}

function renderHelp(): string {
  const usage = (arg: { name: string; required: boolean; type: string }) => {
    const value = arg.name.startsWith('--') ? (arg.type === 'boolean' ? arg.name : `${arg.name} <${arg.name.slice(2)}>`) : `<${arg.name}>`;
    return arg.required ? value : `[${value}]`;
  };
  return [
    `Shelf ${contract.version} — ${contract.description}`, '',
    ...contract.commands.map(command => `  shelf ${[command.name, ...command.args.map(usage)].join(' ')}\n    ${command.description}`),
    '', 'Options: --output auto|json|text, --limit 100, --help, --version',
  ].join('\n');
}

function renderItems(result: any): string {
  const lines = result.items.map((item: any) => `${item.name}\t${item.description ?? '(no description)'}\t${item.path ?? item.remote ?? ''}`);
  if (!lines.length) lines.push('No results.');
  if (result.truncated) lines.push(`Showing ${result.items.length} of ${result.total}; increase --limit for more.`);
  return lines.join('\n');
}

function renderScan(result: any): string {
  return [
    `Indexed ${result.total} repositories: ${result.local} local, ${result.github_only} on GitHub only, ${result.undescribed} undescribed.`,
    `Roots: ${result.roots.join(', ')}`,
    ...(result.github.length ? [`GitHub: ${result.github.join(', ')}`] : []),
    ...(result.truncated ? ['Stopped early at the directory limit; narrow --root or lower --depth.'] : []),
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
  return [repo.name, ...rows.filter(([, value]) => value).map(([key, value]) => `  ${key}: ${value}`)].join('\n');
}
