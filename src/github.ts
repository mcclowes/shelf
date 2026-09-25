/**
 * ---
 * purpose: List an owner's GitHub repositories through the gh CLI, reusing its existing authentication.
 * ---
 */
import { spawnSync } from 'node:child_process';
import { clean } from './describe.ts';
import type { Repo } from './store.ts';

const fields = 'name,nameWithOwner,description,url,isPrivate,isArchived,isFork,primaryLanguage,repositoryTopics,pushedAt';
const maxRepos = '1000';
const timeoutMs = 60_000;
const maxBuffer = 32 * 1024 * 1024;

type GhRepo = {
  name: string; nameWithOwner: string; description: string | null; url: string;
  isPrivate: boolean; isArchived: boolean; isFork: boolean; pushedAt?: string;
  primaryLanguage: { name: string } | null; repositoryTopics: { name: string }[] | null;
};

export function validOwner(owner: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) throw new Error(`Invalid GitHub owner: ${owner}`);
  return owner;
}

export function listGithub(owner: string): Repo[] {
  const result = spawnSync('gh', ['repo', 'list', validOwner(owner), '--limit', maxRepos, '--json', fields], { encoding: 'utf8', timeout: timeoutMs, maxBuffer });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error('Scanning GitHub needs the gh CLI. Install it, run gh auth login, then retry.');
  if (result.error) throw new Error(`gh repo list ${owner} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`gh repo list ${owner} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  return (JSON.parse(result.stdout) as GhRepo[]).map(toRepo);
}

function toRepo(repo: GhRepo): Repo {
  const remote = `github.com/${repo.nameWithOwner}`;
  const description = repo.description ? clean(repo.description) : '';
  const topics = repo.repositoryTopics?.map(topic => topic.name) ?? [];
  return {
    id: remote, name: repo.name, remote,
    ...(description ? { description, description_source: 'github' as const } : {}),
    ...(repo.primaryLanguage ? { language: repo.primaryLanguage.name } : {}),
    ...(topics.length ? { topics } : {}),
    github: { url: repo.url, private: repo.isPrivate, archived: repo.isArchived, fork: repo.isFork, pushed_at: repo.pushedAt },
  };
}
