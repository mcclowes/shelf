import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const main = new URL('./main.ts', import.meta.url);

const githubRepos = [
  { name: 'alpha', nameWithOwner: 'acme/alpha', description: 'Alpha from GitHub', url: 'https://github.com/acme/alpha', isPrivate: true, isArchived: false, isFork: false, primaryLanguage: { name: 'TypeScript' }, repositoryTopics: [{ name: 'cli' }], pushedAt: '2026-09-01T00:00:00Z' },
  { name: 'beta', nameWithOwner: 'acme/beta', description: null, url: 'https://github.com/acme/beta', isPrivate: false, isArchived: true, isFork: false, primaryLanguage: null, repositoryTopics: null },
];

function write(file: string, text: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function repo(root: string, name: string, files: Record<string, string> = {}, remote?: string) {
  const dir = join(root, name);
  write(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(join(dir, '.git', 'config'), remote ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n` : '[core]\n');
  for (const [file, text] of Object.entries(files)) write(join(dir, file), text);
  return dir;
}

function fixture(t: any) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'shelf-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'code');
  const paths = {
    alpha: repo(root, 'alpha', { 'README.md': '# Alpha\n\nLocal alpha readme.', 'AGENTS.md': '' }, 'git@github.com:acme/alpha.git'),
    gamma: repo(join(root, 'group'), 'gamma', { 'package.json': JSON.stringify({ description: 'Gamma package' }) }),
    delta: repo(root, 'delta'),
  };
  repo(join(root, 'alpha', 'node_modules'), 'hidden');
  repo(join(root, 'node_modules'), 'ignored');
  repo(join(root, 'a', 'b', 'c', 'd', 'e'), 'too-deep');
  write(join(dir, 'gh.json'), JSON.stringify(githubRepos));
  write(join(dir, 'bin', 'gh'), `#!/bin/sh\ncat "${join(dir, 'gh.json')}"\n`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  const run = (...args: string[]) => spawnSync(process.execPath, [main.pathname, ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, SHELF_HOME: join(dir, 'config'), PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
  });
  const json = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { dir, root, paths, run, json };
}

test('scan indexes local clones, merges GitHub metadata, and skips dependency and deep directories', t => {
  const { root, paths, json } = fixture(t);
  const scanned = json('scan', '--root', root, '--github', 'acme');
  assert.deepEqual({ total: scanned.total, local: scanned.local, github_only: scanned.github_only, undescribed: scanned.undescribed }, { total: 4, local: 3, github_only: 1, undescribed: 2 });

  const listed = json('list');
  assert.deepEqual(listed.items.map((item: any) => item.name), ['alpha', 'beta', 'delta', 'gamma']);
  assert.ok(listed.scanned_at);

  const alpha = json('show', 'acme/alpha');
  assert.equal(alpha.path, paths.alpha);
  assert.equal(alpha.description, 'Alpha from GitHub');
  assert.equal(alpha.description_source, 'github');
  assert.equal(alpha.language, 'TypeScript');
  assert.deepEqual(alpha.agent_files, ['AGENTS.md']);
  assert.equal(alpha.branch, 'main');
  assert.equal(alpha.github.private, true);

  const gamma = json('show', 'gamma');
  assert.equal(gamma.description_source, 'manifest');
  assert.deepEqual(gamma.manifests, ['package.json']);

  assert.equal(json('show', 'beta').path, undefined);
});

test('scan reuses saved roots and owners, and --no-github drops owners', t => {
  const { root, json } = fixture(t);
  json('scan', '--root', root, '--github', 'acme');
  assert.equal(json('scan').total, 4);
  const local = json('scan', '--no-github');
  assert.deepEqual(local.github, []);
  assert.equal(local.total, 3);
  assert.equal(json('show', 'alpha').description, 'Local alpha readme.');
});

test('search ranks by name and filters on every word', t => {
  const { root, json } = fixture(t);
  json('scan', '--root', root, '--github', 'acme');
  assert.deepEqual(json('search', 'gamma').items.map((item: any) => item.name), ['gamma']);
  assert.deepEqual(json('search', 'typescript').items.map((item: any) => item.name), ['alpha']);
  assert.equal(json('search', 'nothing', 'matches').total, 0);
});

test('describe overrides survive rescans and clear restores the scanned description', t => {
  const { root, run, json } = fixture(t);
  json('scan', '--root', root);
  assert.deepEqual(json('list', '--undescribed').items.map((item: any) => item.name), ['delta']);

  const described = json('describe', 'delta', 'Delta\u0007  service');
  assert.equal(described.description, 'Delta service');
  assert.equal(json('list', '--undescribed').total, 0);
  json('scan');
  assert.equal(json('show', 'delta').description_source, 'override');

  json('describe', 'delta', '--clear');
  assert.equal(json('show', 'delta').description, undefined);
  assert.equal(run('describe', 'delta').status, 1);
});

test('ambiguous and unknown references fail with structured errors', t => {
  const { dir, root, run, json } = fixture(t);
  repo(join(root, 'other'), 'gamma');
  json('scan', '--root', root);
  const ambiguous = run('show', 'gamma');
  assert.equal(ambiguous.status, 1);
  assert.match(JSON.parse(ambiguous.stderr).error.message, /matches 2 repositories/);
  assert.equal(json('show', join(root, 'other', 'gamma')).name, 'gamma');
  assert.equal(JSON.parse(run('show', 'missing').stderr).error.kind, 'invalid_request');
  assert.equal(run('scan', '--github', '--bad').status, 1);
  rmSync(join(dir, 'config'), { recursive: true });
  assert.match(JSON.parse(run('list').stderr).error.message, /shelf scan/);
});

test('sync writes the skill once and refuses a directory it does not own', t => {
  const { dir, run, json } = fixture(t);
  const skills = join(dir, 'skills');
  const first = json('sync', '--skills-dir', skills);
  assert.equal(first.changed, true);
  assert.match(readFileSync(first.file, 'utf8'), /^---\nname: shelf\n/);
  assert.equal(json('sync', '--skills-dir', skills).changed, false);

  const other = join(dir, 'other-skills');
  write(join(other, 'shelf', 'SKILL.md'), 'mine');
  assert.equal(run('sync', '--skills-dir', other).status, 1);
  assert.equal(readFileSync(join(other, 'shelf', 'SKILL.md'), 'utf8'), 'mine');
  assert.ok(!existsSync(join(other, 'shelf', '.shelf-owned')));
});

test('a repository declares related repositories in .shelf.json, visible from both ends', t => {
  const { root, paths, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [
    { repo: 'acme/alpha', relation: 'Consumes the alpha API' },
    { repo: '../../delta', relation: 'Shares a database schema' },
    { repo: 'https://github.com/acme/beta.git' },
    { repo: 'github.com/acme/missing', relation: 'Deploy scripts' },
    { relation: 'no repo' },
  ] }));
  write(join(paths.delta, '.shelf.json'), '{ not json');
  const scanned = json('scan', '--root', root, '--github', 'acme');
  assert.equal(scanned.warnings.length, 2);

  const gamma = json('related', 'gamma');
  assert.deepEqual(gamma.items.map((item: any) => [item.ref, item.name, item.direction, item.source, item.relation]), [
    ['acme/alpha', 'alpha', 'outgoing', 'repo', 'Consumes the alpha API'],
    ['https://github.com/acme/beta.git', 'beta', 'outgoing', 'repo', null],
    ['../../delta', 'delta', 'outgoing', 'repo', 'Shares a database schema'],
    ['github.com/acme/missing', null, 'outgoing', 'repo', 'Deploy scripts'],
  ]);
  assert.equal(gamma.items[2].path, paths.delta);

  const alpha = json('related', 'alpha');
  assert.deepEqual(alpha.items.map((item: any) => [item.name, item.direction, item.relation]), [['gamma', 'incoming', 'Consumes the alpha API']]);
  assert.equal(json('show', 'alpha').related.length, 1);
});

test('relate records machine-local relations that survive rescans and win over repo files', t => {
  const { root, paths, run, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [{ repo: 'alpha', relation: 'From the repo file' }] }));
  json('scan', '--root', root);

  assert.deepEqual(json('relate', 'gamma', 'alpha', 'Mine'), { related: paths.gamma, to: paths.alpha, relation: 'Mine' });
  json('relate', 'delta', 'gamma');
  json('scan');
  assert.deepEqual(json('related', 'gamma').items.map((item: any) => [item.name, item.direction, item.source, item.relation]), [
    ['alpha', 'outgoing', 'local', 'Mine'],
    ['delta', 'incoming', 'local', null],
  ]);

  json('relate', 'gamma', 'alpha', '--clear');
  assert.equal(json('related', 'gamma').items[0].source, 'repo');
  assert.equal(run('relate', 'gamma', 'gamma').status, 1);
  assert.equal(run('relate', 'gamma', 'missing').status, 1);
  assert.equal(run('relate', 'gamma', 'delta', '--clear').status, 1);
});

test('schema describes the CLI offline and text output renders for people', t => {
  const { root, json, run } = fixture(t);
  assert.equal(json('schema').name, 'shelf');
  assert.match(run('--help', '--output', 'text').stdout, /shelf scan/);
  json('scan', '--root', root);
  assert.match(run('list', '--output', 'text').stdout, /delta\t\(no description\)/);
  assert.match(run('show', 'gamma', '--output', 'text').stdout, /description: Gamma package \(manifest\)/);
});

test('a fork clone whose origin is upstream matches its GitHub repository through another remote', t => {
  const { root, json } = fixture(t);
  const fork = repo(root, 'beta');
  write(join(fork, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/upstream/beta.git\n[remote "fork"]\n\turl = git@github.com:acme/beta.git\n');
  json('scan', '--root', root, '--github', 'acme');
  const matches = json('search', 'beta').items;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, fork);
  assert.equal(matches[0].remote, 'github.com/acme/beta');
  assert.deepEqual(json('show', fork).remotes, ['github.com/upstream/beta', 'github.com/acme/beta']);
  assert.equal(json('show', 'upstream/beta').id, fork);
});

test('help for one command describes only that command', t => {
  const { json, run } = fixture(t);
  assert.equal(json('search', '--help').command.name, 'search');
  assert.equal(json('help', 'show').command.name, 'show');
  const text = run('sync', '--help', '--output', 'text').stdout;
  assert.match(text, /shelf sync \[--skills-dir <skills-dir>\]/);
  assert.doesNotMatch(text, /shelf scan/);
  assert.equal(run('help', 'nope').status, 1);
});

test('a repository without a README takes its description from AGENTS.md or CLAUDE.md', t => {
  const { root, json } = fixture(t);
  repo(root, 'epsilon', { 'CLAUDE.md': '# CLAUDE.md\n\nThis file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.\n\n## Architecture\n\nEpsilon is a map of venues.' });
  repo(root, 'zeta', { 'CLAUDE.md': '@AGENTS.md\n', 'AGENTS.md': '# Zeta\n\nShared API client for Weavr integrations.' });
  json('scan', '--root', root);
  assert.equal(json('show', 'epsilon').description, 'Epsilon is a map of venues.');
  assert.equal(json('show', 'epsilon').description_source, 'agents');
  assert.equal(json('show', 'zeta').description, 'Shared API client for Weavr integrations.');
});
