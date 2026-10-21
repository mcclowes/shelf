/**
 * ---
 * purpose: Persist Shelf configuration (roots, GitHub owners, description overrides, local relations) and the derived repository index.
 * ---
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type DescriptionSource = 'override' | 'github' | 'manifest' | 'readme' | 'agents';
export type Repo = {
  /** Absolute path for a local clone; `host/owner/name` for a GitHub repository with no clone. */
  id: string;
  name: string;
  description?: string;
  description_source?: DescriptionSource;
  path?: string;
  /** Normalized `host/owner/name`, shared by a clone and its GitHub entry. */
  remote?: string;
  /** Every remote of a clone with more than one, origin first. */
  remotes?: string[];
  branch?: string;
  last_activity?: string;
  language?: string;
  topics?: string[];
  github?: { url: string; private: boolean; archived: boolean; fork: boolean; pushed_at?: string };
  agent_files?: string[];
  manifests?: string[];
  /** Relations this clone declares in `.shelf.json`, as written; resolved when queried. */
  related?: DeclaredRelation[];
};
export type DeclaredRelation = { ref: string; relation?: string };
/** Keys are `overrideKey` values, so local relations survive moves like description overrides. */
export type LocalRelation = { from: string; to: string; relation?: string };
export type Config = { version: 1; roots: string[]; github: string[]; overrides: Record<string, string>; relations: LocalRelation[]; depth?: number; skill_dirs?: string[] };
export type Index = { version: 1; scanned_at: string; roots: string[]; github: string[]; truncated: boolean; repos: Repo[] };

export const shelfHome = () => process.env.SHELF_HOME ?? join(homedir(), '.config', 'shelf');
const configPath = () => join(shelfHome(), 'config.json');
const indexPath = () => join(shelfHome(), 'index.json');

/** GitHub identities ignore case; paths and other hosts retain their spelling. */
export const identityKey = (key: string): string => /^github\.com\//i.test(key) ? key.toLowerCase() : key;

/** Overrides follow the remote, so a description survives moving or re-cloning a repository. */
export const overrideKey = (repo: Repo) => identityKey(repo.remote ?? repo.id);

export function readConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return { version: 1, roots: [], github: [], overrides: {}, relations: [] };
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version !== 1) throw new Error(`Unsupported Shelf configuration at ${path}.`);
  return { version: 1, roots: data.roots ?? [], github: data.github ?? [], overrides: data.overrides ?? {}, relations: data.relations ?? [],
    ...(data.depth !== undefined ? { depth: data.depth } : {}), ...(data.skill_dirs ? { skill_dirs: data.skill_dirs } : {}) };
}

export const writeConfig = (config: Config) => writeJson(configPath(), config);

export function readIndex(): Index {
  const path = indexPath();
  if (!existsSync(path)) throw new Error('No index yet. Run shelf scan first.');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version !== 1 || !Array.isArray(data.repos)) throw new Error(`Unsupported or invalid Shelf index at ${path}; run shelf scan.`);
  return data;
}

export const writeIndex = (index: Index) => writeJson(indexPath(), index);

export const writeJson = (path: string, data: unknown) => writeText(path, `${JSON.stringify(data, null, 2)}\n`);

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : undefined;
  const staging = mkdtempSync(`${path}.`);
  try {
    chmodSync(staging, 0o700);
    const temporary = join(staging, 'state.json');
    writeFileSync(temporary, text, { mode });
    // Creation applies the current umask, so restore the exact saved mode before replacement.
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
