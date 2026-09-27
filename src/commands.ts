/**
 * ---
 * purpose: Implement each Shelf command as a handler keyed by its contract name, paired with the text renderer for its result.
 * related:
 *   - ./contract.ts - Public command names and arguments these handlers implement.
 *   - ./main.ts - Parses arguments, dispatches here, and prints results.
 *   - ./output.ts - Text renderers, one per kind of result.
 * ---
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { parseArgs, ParseArgsConfig } from 'node:util';
import { contract } from './contract.ts';
import { clean } from './describe.ts';
import { listGithub, validOwner } from './github.ts';
import { page, renderCommandHelp, renderDescribed, renderHelp, renderItems, renderRelation, renderRepo, renderScan, renderSync } from './output.ts';
import { readDeclaredRelations, relatedTo, searchableRelationText } from './relations.ts';
import { applyOverride, findRepo, mergeRepos, searchRepos, summary } from './repos.ts';
import { defaultDepth, findRepositories, readLocalRepo } from './scan.ts';
import { defaultSkillsDir, syncSkill } from './skill.ts';
import { overrideKey, readConfig, readIndex, writeConfig, writeIndex, type Config, type Index, type Repo } from './store.ts';

/** Flags that commands read; main adds the global ones before parsing. */
export const commandOptions = {
  root: { type: 'string', multiple: true }, github: { type: 'string', multiple: true }, 'no-github': { type: 'boolean' },
  depth: { type: 'string' }, undescribed: { type: 'boolean' }, clear: { type: 'boolean' }, 'skills-dir': { type: 'string' },
} satisfies ParseArgsConfig['options'];
export type Options = ReturnType<typeof parseArgs<{ options: typeof commandOptions }>>['values'];
export type Invocation = { args: string[]; options: Options; limit: number };
// biome-ignore lint/suspicious/noExplicitAny: `command` below ties each renderer to its handler's result type.
export type Command = { minArgs: number; maxArgs: number; run: (invocation: Invocation) => unknown; text: (result: any) => string };

const command = <R>(spec: { minArgs: number; maxArgs: number; run: (invocation: Invocation) => R; text: (result: R) => string }): Command => spec;

const defaultRoot = join(homedir(), 'Development');
const maxDepth = 12;

/** Explicit or saved roots must all exist; with neither, the first scan falls back to ~/Development. */
function resolveRoots(requested: string[] | undefined, saved: string[]): string[] {
  const roots = requested?.map(root => resolve(root)) ?? saved;
  if (!roots.length) {
    if (!existsSync(defaultRoot)) throw new Error('No roots configured. Pass --root <directory>.');
    return [defaultRoot];
  }
  const missing = roots.find(root => !existsSync(root));
  if (missing) throw new Error(`Root does not exist: ${missing}`);
  return roots;
}

/** Flags replace the saved roots and owners; without them the saved ones are reused. */
function scanTargets(options: Options, config: Config) {
  const roots = resolveRoots(options.root, config.roots);
  const github = options['no-github'] ? [] : (options.github?.map(validOwner) ?? config.github);
  const depth = Number(options.depth ?? defaultDepth);
  if (!Number.isInteger(depth) || depth < 0 || depth > maxDepth) throw new Error(`--depth must be an integer from 0 to ${maxDepth}.`);
  return { roots, github, depth };
}

function scan({ options }: Invocation) {
  const config = readConfig();
  const { roots, github, depth } = scanTargets(options, config);
  const found = findRepositories(roots, depth);
  const warnings: string[] = [];
  const local = found.paths.map(path => {
    const declared = readDeclaredRelations(path);
    warnings.push(...declared.warnings);
    return { ...readLocalRepo(path), ...(declared.related?.length ? { related: declared.related } : {}) };
  });
  const remote = github.flatMap(listGithub);
  const repos = mergeRepos(local, remote, config.overrides);
  const index: Index = { version: 1, scanned_at: new Date().toISOString(), roots, github, truncated: found.truncated, repos };
  writeConfig({ ...config, roots, github });
  writeIndex(index);
  return {
    scanned_at: index.scanned_at, roots, github, truncated: found.truncated,
    total: repos.length, local: repos.filter(repo => repo.path).length, github_only: repos.filter(repo => !repo.path).length,
    undescribed: repos.filter(repo => !repo.description).length,
    ...(warnings.length ? { warnings } : {}),
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
  if (options.clear) return clearDescription(index, config, repo);
  const description = clean(text);
  if (!description) throw new Error('Description is empty.');
  const key = overrideKey(repo);
  const overrides = { ...config.overrides, [key]: description };
  writeConfig({ ...config, overrides });
  writeIndex({ ...index, repos: index.repos.map(entry => overrideKey(entry) === key ? applyOverride(entry, overrides) : entry) });
  return { described: repo.id, description };
}

/** Clearing an override can't recover the scanned description, so a cleared entry waits for the next scan. */
function clearDescription(index: Index, config: Config, repo: Repo) {
  const key = overrideKey(repo);
  const { [key]: _cleared, ...overrides } = config.overrides;
  writeConfig({ ...config, overrides });
  const repos = index.repos.map(entry => overrideKey(entry) === key && entry.description_source === 'override' ? withoutDescription(entry) : entry);
  writeIndex({ ...index, repos });
  return { described: repo.id, description: null, next: 'Run shelf scan to restore the scanned description.' };
}

const withoutDescription = ({ description: _d, description_source: _s, ...rest }: Repo): Repo => rest;

function relate({ args: [fromRef, toRef, text], options }: Invocation) {
  if (options.clear && text) throw new Error('Pass a relation, or --clear to remove it, not both.');
  const index = readIndex();
  const from = findRepo(index.repos, fromRef);
  const to = findRepo(index.repos, toRef);
  if (from.id === to.id) throw new Error('A repository cannot relate to itself.');
  const config = readConfig();
  const key = { from: overrideKey(from), to: overrideKey(to) };
  const others = config.relations.filter(entry => entry.from !== key.from || entry.to !== key.to);
  if (options.clear) {
    if (others.length === config.relations.length) throw new Error(`No local relation from ${from.id} to ${to.id}.`);
    writeConfig({ ...config, relations: others });
    return { cleared: from.id, to: to.id };
  }
  const relation = text ? clean(text) : undefined;
  if (text && !relation) throw new Error('Relation is empty.');
  writeConfig({ ...config, relations: [...others, { ...key, ...(relation ? { relation } : {}) }] });
  return { related: from.id, to: to.id, relation: relation ?? null };
}

function related({ args: [ref], limit }: Invocation) {
  const index = readIndex();
  const repo = findRepo(index.repos, ref);
  return { ...page(relatedTo(index.repos, readConfig().relations, repo), limit), scanned_at: index.scanned_at };
}

function commandHelp(name: string) {
  const command = contract.commands.find(entry => entry.name === name);
  if (!command) throw new Error(`Unknown command: ${name}. Run shelf --help.`);
  return { name: contract.name, version: contract.version, command };
}

const commands: Record<string, Command> = {
  help: command({ minArgs: 0, maxArgs: 1, run: ({ args: [name] }) => name ? commandHelp(name) : contract, text: result => 'command' in result ? renderCommandHelp(result) : renderHelp() }),
  schema: command({ minArgs: 0, maxArgs: 0, run: () => contract, text: renderHelp }),
  capabilities: command({ minArgs: 0, maxArgs: 0, run: () => contract, text: renderHelp }),
  scan: command({ minArgs: 0, maxArgs: 0, run: scan, text: renderScan }),
  list: command({ minArgs: 0, maxArgs: 0, text: renderItems, run: ({ options, limit }) => {
    const index = readIndex();
    return listed(index, options.undescribed ? index.repos.filter(repo => !repo.description) : index.repos, limit);
  } }),
  search: command({ minArgs: 1, maxArgs: Infinity, text: renderItems, run: ({ args, limit }) => {
    const index = readIndex();
    return listed(index, searchRepos(index.repos, args.join(' '), searchableRelationText(index.repos, readConfig().relations)), limit);
  } }),
  show: command({ minArgs: 1, maxArgs: 1, text: renderRepo, run: ({ args: [ref] }) => {
    const index = readIndex();
    const repo = findRepo(index.repos, ref);
    return { ...repo, related: relatedTo(index.repos, readConfig().relations, repo), scanned_at: index.scanned_at };
  } }),
  describe: command({ minArgs: 1, maxArgs: 2, run: describe, text: renderDescribed }),
  relate: command({ minArgs: 2, maxArgs: 3, run: relate, text: renderRelation }),
  related: command({ minArgs: 1, maxArgs: 1, run: related, text: renderItems }),
  sync: command({ minArgs: 0, maxArgs: 0, run: ({ options }) => syncSkill(options['skills-dir'] ?? defaultSkillsDir), text: renderSync }),
};

export function resolveCommand(positionals: string[]): { command: Command; args: string[] } {
  const [name = 'help', ...args] = positionals;
  const command = commands[name];
  if (!command) throw new Error(`Unknown command: ${name}. Run shelf --help.`);
  if (args.length < command.minArgs || args.length > command.maxArgs) throw new Error(`Wrong number of arguments for ${name}. Run shelf --help.`);
  return { command, args };
}
