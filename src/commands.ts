/**
 * ---
 * purpose: Implement each Shelf command as a handler keyed by its contract name.
 * related:
 *   - ./contract.ts - Public command names and arguments these handlers implement.
 *   - ./main.ts - Parses arguments, dispatches here, and prints results.
 * ---
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { contract } from './contract.ts';
import { clean } from './describe.ts';
import { listGithub, validOwner } from './github.ts';
import { page } from './output.ts';
import { applyOverride, findRepo, mergeRepos, searchRepos, summary } from './repos.ts';
import { defaultDepth, findRepositories, readLocalRepo } from './scan.ts';
import { defaultSkillsDir, syncSkill } from './skill.ts';
import { overrideKey, readConfig, readIndex, writeConfig, writeIndex, type Index, type Repo } from './store.ts';

export type Options = { root?: string[]; github?: string[]; 'no-github'?: boolean; depth?: string; undescribed?: boolean; clear?: boolean; 'skills-dir'?: string };
export type Invocation = { args: string[]; options: Options; limit: number };
type Command = { minArgs: number; maxArgs: number; run: (invocation: Invocation) => unknown };

const defaultRoot = join(homedir(), 'Development');
const maxDepth = 12;

function scan({ options }: Invocation) {
  const config = readConfig();
  const roots = options.root?.map(root => resolve(root)) ?? config.roots;
  if (!roots.length && !existsSync(defaultRoot)) throw new Error('No roots configured. Pass --root <directory>.');
  if (!roots.length) roots.push(defaultRoot);
  for (const root of roots) if (!existsSync(root)) throw new Error(`Root does not exist: ${root}`);
  const github = options['no-github'] ? [] : (options.github?.map(validOwner) ?? config.github);
  const depth = Number(options.depth ?? defaultDepth);
  if (!Number.isInteger(depth) || depth < 0 || depth > maxDepth) throw new Error(`--depth must be an integer from 0 to ${maxDepth}.`);

  const found = findRepositories(roots, depth);
  const local = found.paths.map(readLocalRepo);
  const remote = github.flatMap(listGithub);
  const repos = mergeRepos(local, remote, config.overrides);
  const index: Index = { version: 1, scanned_at: new Date().toISOString(), roots, github, truncated: found.truncated, repos };
  writeConfig({ ...config, roots, github });
  writeIndex(index);
  return {
    scanned_at: index.scanned_at, roots, github, truncated: found.truncated,
    total: repos.length, local: repos.filter(repo => repo.path).length, github_only: repos.filter(repo => !repo.path).length,
    undescribed: repos.filter(repo => !repo.description).length,
  };
}

function listed(index: Index, repos: Repo[], limit: number) {
  return { ...page(repos.map(summary), limit), scanned_at: index.scanned_at };
}

function describe({ args: [ref, text], options }: Invocation) {
  if (Boolean(options.clear) === Boolean(text)) throw new Error('Pass a description, or --clear to remove the override.');
  const index = readIndex();
  const repo = findRepo(index.repos, ref);
  const config = readConfig();
  const key = overrideKey(repo);
  const description = text ? clean(text) : undefined;
  if (text && !description) throw new Error('Description is empty.');
  const overrides = { ...config.overrides };
  if (description) overrides[key] = description;
  else delete overrides[key];
  writeConfig({ ...config, overrides });
  // Clearing an override can't recover the scanned description, so a cleared entry waits for the next scan.
  const repos = index.repos.map(entry => {
    if (overrideKey(entry) !== key) return entry;
    if (description) return applyOverride(entry, overrides);
    const { description: _d, description_source: _s, ...rest } = entry;
    return entry.description_source === 'override' ? rest : entry;
  });
  writeIndex({ ...index, repos });
  return { described: repo.id, description: description ?? null, ...(description ? {} : { next: 'Run shelf scan to restore the scanned description.' }) };
}

const commands: Record<string, Command> = {
  help: { minArgs: 0, maxArgs: 0, run: () => contract },
  schema: { minArgs: 0, maxArgs: 0, run: () => contract },
  capabilities: { minArgs: 0, maxArgs: 0, run: () => contract },
  scan: { minArgs: 0, maxArgs: 0, run: scan },
  list: { minArgs: 0, maxArgs: 0, run: ({ options, limit }) => {
    const index = readIndex();
    return listed(index, options.undescribed ? index.repos.filter(repo => !repo.description) : index.repos, limit);
  } },
  search: { minArgs: 1, maxArgs: Infinity, run: ({ args, limit }) => {
    const index = readIndex();
    return listed(index, searchRepos(index.repos, args.join(' ')), limit);
  } },
  show: { minArgs: 1, maxArgs: 1, run: ({ args: [ref] }) => {
    const index = readIndex();
    return { ...findRepo(index.repos, ref), scanned_at: index.scanned_at };
  } },
  describe: { minArgs: 1, maxArgs: 2, run: describe },
  sync: { minArgs: 0, maxArgs: 0, run: ({ options }) => syncSkill(options['skills-dir'] ?? defaultSkillsDir) },
};

export function resolveCommand(positionals: string[]): { command: Command; args: string[] } {
  const [name = 'help', ...args] = positionals;
  const command = commands[name];
  if (!command) throw new Error(`Unknown command: ${name}. Run shelf --help.`);
  if (args.length < command.minArgs || args.length > command.maxArgs) throw new Error(`Wrong number of arguments for ${name}. Run shelf --help.`);
  return { command, args };
}
