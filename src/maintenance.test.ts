import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { skillText } from './skill.ts';

function fixture(t: TestContext) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'shelf-maintenance-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = join(home, 'state');
  const root = join(home, 'Development');
  const repo = join(root, 'example');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# Example\n\nAn example repository.\n');
  mkdirSync(join(home, '.claude'));
  mkdirSync(join(home, '.codex'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SHELF_HOME: state };
  const run = (...args: string[]) => spawnSync(process.execPath, [new URL('./main.ts', import.meta.url).pathname, ...args], {
    cwd: home, env, encoding: 'utf8', timeout: 10000,
  });
  const read = (file: string) => JSON.parse(readFileSync(join(state, file), 'utf8'));
  return { home, state, root, repo, env, run, read };
}

function completed(child: ChildProcess): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout!.on('data', data => { stdout += data; });
    child.stderr!.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

test('first query builds the local index and installs guidance for Claude and Codex', t => {
  const { home, state, run, read } = fixture(t);
  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout).items.map((repo: { name: string }) => repo.name), ['example']);
  assert.deepEqual(read('config.json').github, []);
  assert.ok(existsSync(join(state, 'index.json')));
  for (const dir of ['.claude/skills', '.agents/skills']) {
    assert.equal(readFileSync(join(home, dir, 'shelf/SKILL.md'), 'utf8'), skillText);
  }
});

test('an offline refresh serves the previous index and backs off before retrying', t => {
  const { home, state, root, env, run, read } = fixture(t);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  const calls = join(home, 'github-calls');
  writeFileSync(gh, `#!/bin/sh\necho call >> "${calls}"\necho offline >&2\nexit 1\n`);
  chmodSync(gh, 0o755);
  env.PATH = `${bin}:${env.PATH}`;
  assert.equal(run('scan', '--root', root).status, 0);
  const config = read('config.json');
  config.github = ['acme'];
  writeFileSync(join(state, 'config.json'), JSON.stringify(config));
  const index = read('index.json');
  index.scanned_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(join(state, 'index.json'), JSON.stringify(index));
  const before = readFileSync(join(state, 'index.json'), 'utf8');

  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).total, 1);
  assert.match(JSON.parse(result.stderr).warning.message, /offline/);
  assert.equal(readFileSync(join(state, 'index.json'), 'utf8'), before);
  assert.deepEqual(read('config.json'), config);
  assert.equal(run('list').status, 0);
  assert.equal(readFileSync(calls, 'utf8'), 'call\n');
});

test('queries refresh an index older than a day while retaining saved roots, depth, and descriptions', t => {
  const { state, root, repo, run, read } = fixture(t);
  assert.equal(run('scan', '--root', root, '--depth', '1').status, 0);
  assert.equal(run('describe', 'example', 'Keep my description').status, 0);
  const index = read('index.json');
  index.scanned_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(join(state, 'index.json'), JSON.stringify(index));
  mkdirSync(join(root, 'new-repo/.git'), { recursive: true });
  mkdirSync(join(root, 'group/deeper-repo/.git'), { recursive: true });

  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout);
  assert.deepEqual(listed.items.map((repo: { name: string }) => repo.name), ['example', 'new-repo']);
  assert.equal(listed.items.find((item: { path: string }) => item.path === repo).description, 'Keep my description');
  assert.notEqual(listed.scanned_at, index.scanned_at);
  const saved = readFileSync(join(state, 'index.json'), 'utf8');
  assert.equal(run('search', 'example').status, 0);
  assert.equal(readFileSync(join(state, 'index.json'), 'utf8'), saved);
});

test('unowned guidance is preserved without breaking queries or other agent setup', t => {
  const { home, run } = fixture(t);
  const claude = join(home, '.claude/skills/shelf');
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, 'SKILL.md'), 'My own guidance.\n');
  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).total, 1);
  assert.match(JSON.parse(result.stderr).warning.message, /not written by Shelf/);
  assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'My own guidance.\n');
  assert.equal(existsSync(join(claude, '.shelf-owned')), false);
  assert.equal(readFileSync(join(home, '.agents/skills/shelf/SKILL.md'), 'utf8'), skillText);
});

test('cached-only queries and introspection never bootstrap, scan, or update guidance', t => {
  const { home, state, run, read } = fixture(t);
  for (const args of [[], ['--help'], ['help', 'scan'], ['schema'], ['capabilities'], ['--version'], ['list', '--root', home]]) {
    run(...args);
    assert.equal(existsSync(state), false, args.join(' '));
    assert.equal(existsSync(join(home, '.claude/skills')), false);
    assert.equal(existsSync(join(home, '.agents')), false);
  }
  const missing = run('list', '--no-refresh');
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stderr).error.message, /shelf scan/);
  assert.equal(existsSync(state), false);

  assert.equal(run('list').status, 0);
  const index = read('index.json');
  index.scanned_at = '2000-01-01T00:00:00.000Z';
  writeFileSync(join(state, 'index.json'), JSON.stringify(index));
  const skill = join(home, '.claude/skills/shelf/SKILL.md');
  writeFileSync(skill, 'Keep cached guidance.\n');
  assert.equal(run('list', '--no-refresh').status, 0);
  assert.deepEqual(read('index.json'), index);
  assert.equal(readFileSync(skill, 'utf8'), 'Keep cached guidance.\n');
});

test('a scan cannot overwrite a description saved by another concurrent command', async t => {
  const { home, root, env, run, read } = fixture(t);
  assert.equal(run('list').status, 0);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  const started = join(home, 'started');
  const release = join(home, 'release');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ntouch "${started}"\nwhile [ ! -f "${release}" ]; do sleep 0.02; done\nprintf '[]'\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  env.PATH = `${bin}:${env.PATH}`;
  const child = (...args: string[]) => spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname, ...args], {
    cwd: home, env, timeout: 10000,
  });
  const scanner = child('scan', '--root', root, '--github', 'acme');
  const scanning = completed(scanner);
  t.after(() => { scanner.kill(); if (existsSync(home)) writeFileSync(release, 'release'); });
  const deadline = Date.now() + 5000;
  while (!existsSync(started) && Date.now() < deadline) await setTimeout(20);
  assert.ok(existsSync(started), 'scan reached GitHub');
  const describing = completed(child('describe', 'example', 'Concurrent description'));
  await setTimeout(150);
  writeFileSync(release, 'release');
  for (const result of await Promise.all([scanning, describing])) assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(run('show', 'example').stdout).description, 'Concurrent description');
  assert.ok(Object.values(read('config.json').overrides).includes('Concurrent description'));
});

test('sync covers detected agents and remembers a custom destination for automatic updates', t => {
  const { home, state, run, read } = fixture(t);
  const result = run('sync');
  assert.equal(result.status, 0, result.stderr);
  for (const directory of ['.claude/skills', '.agents/skills']) {
    assert.equal(readFileSync(join(home, directory, 'shelf/SKILL.md'), 'utf8'), skillText);
  }
  const custom = join(home, 'custom/skills');
  assert.equal(run('sync', '--skills-dir', custom).status, 0);
  assert.ok(read('config.json').skill_dirs.includes(custom));
  rmSync(join(custom, 'shelf/SKILL.md'));
  assert.equal(run('list').status, 0);
  assert.equal(readFileSync(join(custom, 'shelf/SKILL.md'), 'utf8'), skillText);
  assert.deepEqual(read('config.json').roots, [join(home, 'Development')]);
  assert.ok(existsSync(join(state, 'index.json')));
});

test('automatic updates preserve user edits inside an owned skill', t => {
  const { home, run } = fixture(t);
  assert.equal(run('list').status, 0);
  const file = join(home, '.claude/skills/shelf/SKILL.md');
  writeFileSync(file, 'My edited Shelf guidance.\n');
  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(file, 'utf8'), 'My edited Shelf guidance.\n');
  assert.match(JSON.parse(result.stderr).warning.message, /edited/);
  const synced = run('sync');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(readFileSync(file, 'utf8'), 'My edited Shelf guidance.\n');
  assert.match(JSON.parse(synced.stderr).warning.message, /edited/);
  assert.equal(run('sync', '--skills-dir', join(home, '.claude/skills')).status, 0);
  assert.equal(readFileSync(file, 'utf8'), skillText);
});

test('first use upgrades an untouched legacy skill without an existing content fingerprint', t => {
  const { home, run } = fixture(t);
  const dir = join(home, '.claude/skills/shelf');
  mkdirSync(dir, { recursive: true });
  const legacy = readFileSync(new URL('./fixtures/skill-v0.2.0.md', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'SKILL.md'), legacy);
  writeFileSync(join(dir, '.shelf-owned'), 'shelf-skill-v1\n');
  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), skillText);
  const before = readFileSync(join(dir, '.shelf-content.sha256'), 'utf8');
  assert.equal(run('list').status, 0);
  assert.equal(readFileSync(join(dir, '.shelf-content.sha256'), 'utf8'), before);
});

test('concurrent first queries share one setup and leave usable state', async t => {
  const { home, env, read } = fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => completed(spawn(process.execPath,
    [new URL('./main.ts', import.meta.url).pathname, 'list'], { cwd: home, env, timeout: 10000 }))));
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).total, 1);
  }
  assert.equal(read('index.json').repos.length, 1);
  assert.equal(readFileSync(join(home, '.agents/skills/shelf/SKILL.md'), 'utf8'), skillText);
});

test('queries use the cache during a live update and recover a dead process lock', t => {
  const { state, run } = fixture(t);
  assert.equal(run('list').status, 0);
  const lock = join(state, '.lock');
  writeFileSync(lock, `${process.pid}\n`);
  const cached = run('list');
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(cached.stderr, '');
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid}\n`);
  writeFileSync(lock, '2147483647\n');
  const recovered = run('describe', 'example', 'Recovered update');
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(existsSync(lock), false);
  assert.equal(JSON.parse(run('show', 'example').stdout).description, 'Recovered update');
});

test('damaged index data is reported and preserved instead of silently rebuilt', t => {
  const { state, run } = fixture(t);
  mkdirSync(state);
  writeFileSync(join(state, 'index.json'), '{ damaged state');
  const result = run('list');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.kind, 'invalid_request');
  assert.equal(readFileSync(join(state, 'index.json'), 'utf8'), '{ damaged state');
  assert.equal(existsSync(join(state, 'config.json')), false);
});

test('automatic bootstrap reuses configured GitHub owners and the explicit state directory', t => {
  const { home, state, env, run } = fixture(t);
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2 $3" = "repo list acme" ] || exit 1\nprintf \'[{"name":"remote","nameWithOwner":"acme/remote","description":"Remote repository","url":"https://github.com/acme/remote"}]\'\n');
  chmodSync(join(bin, 'gh'), 0o755);
  env.PATH = `${bin}:${env.PATH}`;
  mkdirSync(state);
  const config = { version: 1, roots: [join(home, 'Development')], github: ['acme'], overrides: {}, relations: [] };
  writeFileSync(join(state, 'config.json'), JSON.stringify(config));
  const result = run('list');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).items.map((repo: { name: string }) => repo.name), ['example', 'remote']);
  assert.equal(existsSync(join(home, '.config/shelf')), false);
});
