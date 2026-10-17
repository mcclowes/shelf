import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { RelatedItem } from './relations.ts';

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

function fixture(t: TestContext) {
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
  assert.deepEqual(listed.items.map((item: { name: string }) => item.name), ['alpha', 'beta', 'delta', 'gamma']);
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

test('scan exposes modern and legacy command catalogs without executing them', t => {
  const { dir, root, paths, json } = fixture(t);
  const catalog = '# Commands\n\n- Unsafe fixture: `touch should-not-exist` #writes\n';
  write(join(paths.alpha, '.saggar/commands.md'), catalog);
  write(join(paths.gamma, '.clip/commands.md'), catalog);
  write(join(paths.delta, '.clip/commands.md'), catalog);
  write(join(paths.delta, '.saggar/commands.md'), catalog);

  json('scan', '--root', root, '--no-github');

  assert.deepEqual(json('show', 'alpha').agent_files, ['AGENTS.md', '.saggar/commands.md']);
  assert.deepEqual(json('show', 'gamma').agent_files, ['.clip/commands.md']);
  assert.deepEqual(json('show', 'delta').agent_files, ['.clip/commands.md', '.saggar/commands.md']);
  assert.equal(existsSync(join(dir, 'should-not-exist')), false);
  for (const path of Object.values(paths)) assert.equal(existsSync(join(path, 'should-not-exist')), false);
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

for (const depth of ['', '   ', '\t\n', '\u00a0']) {
  test(`scan rejects blank depth ${JSON.stringify(depth)} without replacing saved state`, t => {
    const { dir, root, run, json } = fixture(t);
    assert.equal(json('scan', '--root', root, '--no-github').local, 3);
    const config = join(dir, 'config', 'config.json');
    const index = join(dir, 'config', 'index.json');
    const beforeConfig = readFileSync(config);
    const beforeIndex = readFileSync(index);
    const otherRoot = join(dir, 'other-root');
    mkdirSync(otherRoot);

    const result = run('scan', '--root', otherRoot, '--github', 'other-owner', '--depth', depth);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr).error, {
      kind: 'invalid_request', message: '--depth must be an integer from 0 to 12.',
    });
    assert.deepEqual(readFileSync(config), beforeConfig);
    assert.deepEqual(readFileSync(index), beforeIndex);
  });
}

test('scan keeps the default depth and accepts explicit zero and maximum depth', t => {
  const { root, json } = fixture(t);
  const omitted = json('scan', '--root', root, '--no-github').local;
  const zero = json('scan', '--depth', '0', '--no-github').local;
  const maximum = json('scan', '--depth', '12', '--no-github').local;

  assert.deepEqual({ omitted, zero, maximum }, { omitted: 3, zero: 0, maximum: 4 });
});

test('scan rejects a file root without changing the saved configuration or index', t => {
  const { dir, root, run, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  const beforeConfig = readFileSync(config, 'utf8');
  const beforeIndex = readFileSync(index, 'utf8');
  const file = join(dir, 'not-a-directory.txt');
  write(file, 'A file cannot be a scan root.\n');

  const result = run('scan', '--root', file, '--no-github');

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.kind, 'invalid_request');
  assert.equal(error.message, `Root is not a directory: ${file}`);
  assert.equal(readFileSync(config, 'utf8'), beforeConfig);
  assert.equal(readFileSync(index, 'utf8'), beforeIndex);
});

test('scan rejects an unreadable root without changing the saved configuration or index', t => {
  if (!process.getuid || process.getuid() === 0) return t.skip('Requires a non-root Unix user for permission checks.');
  const { dir, root, run, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  const beforeConfig = readFileSync(config, 'utf8');
  const beforeIndex = readFileSync(index, 'utf8');
  chmodSync(root, 0);
  let result: ReturnType<typeof run>;
  try {
    result = run('scan', '--root', root, '--no-github');
  } finally {
    chmodSync(root, 0o700);
  }

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr).error;
  assert.equal(error.kind, 'invalid_request');
  assert.equal(error.message, `Cannot read root: ${root}`);
  assert.equal(readFileSync(config, 'utf8'), beforeConfig);
  assert.equal(readFileSync(index, 'utf8'), beforeIndex);
});

for (const saved of [false, true]) {
  test(`scan rejects file roots in ${saved ? 'saved configuration' : 'mixed explicit roots'} before writing state`, t => {
    const { dir, root, run, json } = fixture(t);
    json('scan', '--root', root, '--no-github');
    const config = join(dir, 'config', 'config.json');
    const index = join(dir, 'config', 'index.json');
    const file = join(dir, 'not-a-directory.txt');
    write(file, 'Not a directory.\n');
    if (saved) {
      const data = JSON.parse(readFileSync(config, 'utf8'));
      write(config, JSON.stringify({ ...data, roots: [file] }));
    }
    const beforeConfig = readFileSync(config, 'utf8');
    const beforeIndex = readFileSync(index, 'utf8');

    const result = saved ? run('scan', '--no-github') : run('scan', '--root', root, '--root', file, '--no-github');

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr).error, { kind: 'invalid_request', message: `Root is not a directory: ${file}` });
    assert.equal(readFileSync(config, 'utf8'), beforeConfig);
    assert.equal(readFileSync(index, 'utf8'), beforeIndex);
  });
}

test('missing roots keep the existing error and leave scan state untouched', t => {
  const { dir, root, run, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  const beforeConfig = readFileSync(config, 'utf8');
  const beforeIndex = readFileSync(index, 'utf8');
  const missing = join(dir, 'missing');

  const result = run('scan', '--root', missing, '--no-github');

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr).error, { kind: 'invalid_request', message: `Root does not exist: ${missing}` });
  assert.equal(readFileSync(config, 'utf8'), beforeConfig);
  assert.equal(readFileSync(index, 'utf8'), beforeIndex);
});

test('scan accepts symlinked directory roots and rejects symlinked file roots', t => {
  const { dir, root, run, json } = fixture(t);
  const directoryLink = join(dir, 'directory-link');
  symlinkSync(root, directoryLink, 'dir');
  assert.equal(json('scan', '--root', directoryLink, '--no-github').local, 3);

  const file = join(dir, 'not-a-directory.txt');
  const fileLink = join(dir, 'file-link');
  write(file, 'Not a directory.\n');
  symlinkSync(file, fileLink, 'file');
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  const beforeConfig = readFileSync(config, 'utf8');
  const beforeIndex = readFileSync(index, 'utf8');

  const result = run('scan', '--root', fileLink, '--no-github');

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr).error, { kind: 'invalid_request', message: `Root is not a directory: ${fileLink}` });
  assert.equal(readFileSync(config, 'utf8'), beforeConfig);
  assert.equal(readFileSync(index, 'utf8'), beforeIndex);
});

test('scan still skips unreadable nested directories', t => {
  if (!process.getuid || process.getuid() === 0) return t.skip('Requires a non-root Unix user for permission checks.');
  const { root, json } = fixture(t);
  const nested = repo(root, 'unreadable');
  chmodSync(nested, 0);
  try {
    assert.equal(json('scan', '--root', root, '--no-github').local, 3);
    assert.deepEqual(json('list').items.map((item: { name: string }) => item.name), ['alpha', 'delta', 'gamma']);
  } finally {
    chmodSync(nested, 0o700);
  }
});

test('search ranks by name and filters on every word', t => {
  const { root, json } = fixture(t);
  json('scan', '--root', root, '--github', 'acme');
  assert.deepEqual(json('search', 'gamma').items.map((item: { name: string }) => item.name), ['gamma']);
  assert.deepEqual(json('search', 'typescript').items.map((item: { name: string }) => item.name), ['alpha']);
  assert.equal(json('search', 'nothing', 'matches').total, 0);
});

test('failed state promotion removes only its staging and permits a subsequent scan', t => {
  const { dir, root, run, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const home = join(dir, 'config');
  const index = join(home, 'index.json');
  rmSync(index);
  mkdirSync(index, { mode: 0o750 });
  write(join(index, 'sentinel'), 'Keep blocked target.\n');
  write(join(home, 'index.json.previous.tmp'), 'Keep unrelated temporary file.\n');
  write(join(home, '.index.json-preserved', 'sentinel'), 'Keep unrelated staging.\n');
  const original = statSync(index);
  const before = readdirSync(home).sort();

  const failed = run('scan', '--no-github');

  assert.equal(failed.status, 1);
  const error = JSON.parse(failed.stderr).error;
  assert.equal(error.kind, 'invalid_request');
  assert.match(error.message, /rename/);
  assert.match(error.message, /EISDIR|ENOTDIR/);
  assert.deepEqual(readdirSync(home).sort(), before);
  assert.equal(statSync(index).ino, original.ino);
  assert.equal(statSync(index).mode, original.mode);
  assert.equal(readFileSync(join(index, 'sentinel'), 'utf8'), 'Keep blocked target.\n');
  assert.equal(readFileSync(join(home, 'index.json.previous.tmp'), 'utf8'), 'Keep unrelated temporary file.\n');
  assert.equal(readFileSync(join(home, '.index.json-preserved', 'sentinel'), 'utf8'), 'Keep unrelated staging.\n');

  rmSync(index, { recursive: true });
  assert.equal(json('scan', '--no-github').local, 3);
  assert.equal(json('show', 'alpha').name, 'alpha');
  assert.deepEqual(readdirSync(home).sort(), before);
});

for (const fault of ['partial write', 'chmod']) {
  test(`a state ${fault} failure preserves saved data and removes its staging`, t => {
    const { dir, root, run, json } = fixture(t);
    json('scan', '--root', root, '--no-github');
    const home = join(dir, 'config');
    const files = ['config.json', 'index.json'].map(name => join(home, name));
    chmodSync(files[0]!, 0o640);
    chmodSync(files[1]!, 0o600);
    write(join(home, 'config.json.previous.tmp'), 'Keep unrelated staging.\n');
    const before = files.map(file => ({ bytes: readFileSync(file), mode: statSync(file).mode }));
    const entries = readdirSync(home).sort();
    const preload = join(dir, 'fault.mjs');
    write(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const target = process.env.SHELF_HOME + '/config.json.';
      const fault = ${JSON.stringify(fault)};
      const original = fs[fault === 'partial write' ? 'writeFileSync' : 'chmodSync'];
      fs[fault === 'partial write' ? 'writeFileSync' : 'chmodSync'] = (file, ...args) => {
        if (String(file).startsWith(target) && (fault === 'partial write' || !fs.statSync(file).isDirectory())) {
          if (fault === 'partial write') original(file, 'partial');
          throw new Error('fixture ' + fault + ' failure');
        }
        return original(file, ...args);
      };
      syncBuiltinESMExports();
    `);

    const failed = spawnSync(process.execPath, ['--import', preload, main.pathname, 'describe', 'delta', 'Unsaved'], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SHELF_HOME: home },
    });

    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(JSON.parse(failed.stderr), { error: { kind: 'invalid_request', message: `fixture ${fault} failure` } });
    assert.deepEqual(files.map(file => ({ bytes: readFileSync(file), mode: statSync(file).mode })), before);
    assert.deepEqual(readdirSync(home).sort(), entries);
    assert.equal(readFileSync(join(home, 'config.json.previous.tmp'), 'utf8'), 'Keep unrelated staging.\n');
    assert.equal(json('describe', 'delta', 'Saved after retry').description, 'Saved after retry');
    assert.deepEqual(readdirSync(home).sort(), entries);
    assert.equal(run('show', 'delta').status, 0);
  });
}

test('state writes preserve a pre-existing temporary file with the same process ID', t => {
  const { dir, root } = fixture(t);
  const home = join(dir, 'config');
  const preload = join(dir, 'previous-staging.mjs');
  write(preload, `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    mkdirSync(process.env.SHELF_HOME, { recursive: true });
    for (const name of ['config.json', 'index.json']) {
      writeFileSync(join(process.env.SHELF_HOME, name + '.' + process.pid + '.tmp'), 'Keep previous staging.\\n', { mode: 0o640 });
    }
  `);
  const scanned = spawnSync(process.execPath, ['--import', preload, main.pathname, 'scan', '--root', root, '--no-github'], {
    cwd: dir, encoding: 'utf8', timeout: 10000, env: { ...process.env, SHELF_HOME: home },
  });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(JSON.parse(scanned.stdout).local, 3);
  const previous = readdirSync(home).filter(name => name.endsWith('.tmp'));
  assert.equal(previous.length, 2);
  for (const name of previous) {
    assert.equal(readFileSync(join(home, name), 'utf8'), 'Keep previous staging.\n');
    assert.equal(statSync(join(home, name)).mode & 0o777, 0o640 & ~process.umask());
  }
  assert.equal(readdirSync(home).length, 4);
});

test('private state staging remains writable when a child umask removes owner permissions', t => {
  const { dir, root, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const home = join(dir, 'config');
  const files = ['config.json', 'index.json'].map(name => join(home, name));
  for (const file of files) chmodSync(file, 0o640);
  const parentUmask = process.umask();
  const preload = join(dir, 'owner-umask.mjs');
  write(preload, 'process.umask(0o700);\n');
  const scanned = spawnSync(process.execPath, ['--import', preload, main.pathname, 'scan', '--no-github'], {
    cwd: dir, encoding: 'utf8', timeout: 10000, env: { ...process.env, SHELF_HOME: home },
  });
  assert.equal(scanned.status, 0, scanned.stderr);
  assert.equal(JSON.parse(scanned.stdout).local, 3);
  assert.deepEqual(files.map(file => statSync(file).mode & 0o777), [0o640, 0o640]);
  assert.deepEqual(readdirSync(home).sort(), ['config.json', 'index.json']);
  assert.equal(process.umask(), parentUmask);
});

test('describe preserves restricted configuration and index permissions while updating content', t => {
  const { dir, root, paths, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  chmodSync(config, 0o600);
  chmodSync(index, 0o640);

  json('describe', 'delta', 'Updated description');

  assert.deepEqual({
    configMode: statSync(config).mode & 0o777,
    indexMode: statSync(index).mode & 0o777,
    override: JSON.parse(readFileSync(config, 'utf8')).overrides[paths.delta],
    description: json('show', 'delta').description,
  }, { configMode: 0o600, indexMode: 0o640, override: 'Updated description', description: 'Updated description' });
});

test('scan preserves existing modes and new state files follow the process umask', t => {
  const { dir, root, json } = fixture(t);
  json('scan', '--root', root, '--no-github');
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  const newMode = 0o666 & ~process.umask();
  assert.deepEqual([statSync(config).mode & 0o777, statSync(index).mode & 0o777], [newMode, newMode]);
  chmodSync(config, 0o640);
  chmodSync(index, 0o600);
  const otherRoot = join(dir, 'other-root');
  const added = repo(otherRoot, 'epsilon');

  assert.equal(json('scan', '--root', otherRoot, '--no-github').local, 1);

  assert.deepEqual({
    configMode: statSync(config).mode & 0o777,
    indexMode: statSync(index).mode & 0o777,
    roots: JSON.parse(readFileSync(config, 'utf8')).roots,
    indexed: json('show', 'epsilon').path,
  }, { configMode: 0o640, indexMode: 0o600, roots: [otherRoot], indexed: added });
});

test('a restrictive child umask affects new files but preserves existing permissions on replacement', t => {
  const { dir, root, paths } = fixture(t);
  const config = join(dir, 'config', 'config.json');
  const index = join(dir, 'config', 'index.json');
  const preload = join(dir, 'umask.mjs');
  write(preload, 'process.umask(0o077);\n');
  const parentUmask = process.umask();
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, ['--import', preload, main.pathname, ...args], {
      cwd: dir, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SHELF_HOME: join(dir, 'config'), PATH: `${join(dir, 'bin')}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  run('scan', '--root', root, '--no-github');
  assert.deepEqual([statSync(config).mode & 0o777, statSync(index).mode & 0o777], [0o600, 0o600]);
  chmodSync(config, 0o640);
  chmodSync(index, 0o640);

  run('describe', 'delta', 'Description under restrictive umask');
  assert.deepEqual([statSync(config).mode & 0o777, statSync(index).mode & 0o777], [0o640, 0o640]);
  run('scan', '--no-github');
  assert.deepEqual({
    configMode: statSync(config).mode & 0o777,
    indexMode: statSync(index).mode & 0o777,
    override: JSON.parse(readFileSync(config, 'utf8')).overrides[paths.delta],
    description: run('show', 'delta').description,
    parentUmask: process.umask(),
  }, {
    configMode: 0o640, indexMode: 0o640, override: 'Description under restrictive umask',
    description: 'Description under restrictive umask', parentUmask,
  });
});

test('describe overrides survive rescans and clear restores the scanned description', t => {
  const { root, run, json } = fixture(t);
  json('scan', '--root', root);
  assert.deepEqual(json('list', '--undescribed').items.map((item: { name: string }) => item.name), ['delta']);

  const described = json('describe', 'delta', 'Delta\u0007  service');
  assert.equal(described.description, 'Delta service');
  assert.equal(json('list', '--undescribed').total, 0);
  json('scan');
  assert.equal(json('show', 'delta').description_source, 'override');

  json('describe', 'delta', '--clear');
  assert.equal(json('show', 'delta').description, undefined);
  assert.equal(run('describe', 'delta').status, 1);
});

test('scan rejects a foreign flag before creating saved state', t => {
  const { dir, root, run } = fixture(t);

  const result = run('scan', '--root', root, '--no-github', '--clear');

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).error.kind, 'invalid_request');
  assert.match(JSON.parse(result.stderr).error.message, /scan.*--clear/);
  assert.equal(existsSync(join(dir, 'config')), false);
});

for (const name of ['scan', 'list', 'search', 'show', 'describe', 'related', 'relate', 'sync', 'schema', 'capabilities']) {
  test(`${name} rejects foreign flags without changing saved descriptions or relations`, t => {
    const { dir, root, run, json } = fixture(t);
    json('scan', '--root', root, '--no-github');
    json('describe', 'delta', 'Keep this description');
    json('relate', 'gamma', 'alpha', 'Keep this relation');
    const home = join(dir, 'config');
    const files = ['config.json', 'index.json'].map(file => join(home, file));
    chmodSync(files[0]!, 0o640);
    chmodSync(files[1]!, 0o600);
    const state = () => files.map(file => ({ bytes: readFileSync(file), mode: statSync(file).mode, modified: statSync(file).mtimeMs }));
    const before = state();
    const entries = readdirSync(home).sort();
    const githubCall = join(dir, 'github-called');
    write(join(dir, 'bin', 'gh'), `#!/bin/sh\ntouch "${githubCall}"\ncat "${join(dir, 'gh.json')}"\n`);
    const skills = join(dir, 'new-skills');
    const args: Record<string, string[]> = {
      scan: ['--root', root, '--github', 'acme', '--clear'],
      list: ['--root', root],
      search: ['alpha', '--undescribed'],
      show: ['alpha', '--depth', '1'],
      describe: ['delta', 'Unexpected change', '--github', 'acme'],
      related: ['alpha', '--clear'],
      relate: ['gamma', 'alpha', 'Unexpected relation', '--no-github'],
      sync: ['--skills-dir', skills, '--undescribed'],
      schema: ['--skills-dir', skills],
      capabilities: ['--clear'],
    };

    const rejected = run(name, ...args[name]!);

    assert.equal(rejected.status, 1, rejected.stdout);
    assert.equal(rejected.stdout, '');
    assert.equal(JSON.parse(rejected.stderr).error.kind, 'invalid_request');
    assert.match(JSON.parse(rejected.stderr).error.message, new RegExp(`${name}.*--`));
    assert.deepEqual(state(), before);
    assert.deepEqual(readdirSync(home).sort(), entries);
    assert.equal(existsSync(githubCall), false);
    assert.equal(existsSync(skills), false);
    assert.equal(json('show', 'delta').description, 'Keep this description');
    assert.equal(json('related', 'gamma').items[0].relation, 'Keep this relation');
  });
}

test('foreign flags are rejected before damaged saved state is read', t => {
  const { dir, root, run } = fixture(t);
  const files = ['config.json', 'index.json'].map(file => join(dir, 'config', file));
  for (const file of files) write(file, '{ damaged state');
  const before = files.map(file => readFileSync(file));

  for (const args of [['scan', '--root', root, '--clear'], ['list', '--root', root]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.kind, 'invalid_request');
    assert.match(JSON.parse(result.stderr).error.message, /does not accept --/);
  }

  assert.deepEqual(files.map(file => readFileSync(file)), before);
});

test('help, version, and valid global flags retain their dispatch behavior', t => {
  const { dir, root, json } = fixture(t);
  assert.equal(json('scan', '--clear', '--help').command.name, 'scan');
  assert.equal(json('help', 'scan', '--clear').command.name, 'scan');
  assert.equal(json('--help', '--clear').name, 'shelf');
  assert.equal(json('scan', '--clear', '--version').version, '0.3.0');
  assert.equal(json('--version', '--root', root).name, 'shelf');
  assert.equal(json('schema', '-o', 'json', '--limit', '1').name, 'shelf');
  assert.equal(existsSync(join(dir, 'config')), false);
  assert.equal(json('scan', '--root', root, '--no-github', '--depth', '4', '--output', 'json', '--limit', '1').local, 3);
  assert.equal(json('list', '--undescribed', '--limit', '1').items.length, 1);
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
  assert.match(readFileSync(first.file, 'utf8'), /relation explanations/);
  assert.equal(json('sync', '--skills-dir', skills).changed, false);

  const other = join(dir, 'other-skills');
  write(join(other, 'shelf', 'SKILL.md'), 'mine');
  assert.equal(run('sync', '--skills-dir', other).status, 1);
  assert.equal(readFileSync(join(other, 'shelf', 'SKILL.md'), 'utf8'), 'mine');
  assert.ok(!existsSync(join(other, 'shelf', '.shelf-owned')));
});

test('scan warns when a relation file is a directory while keeping repository results', t => {
  const { root, paths, json } = fixture(t);
  const relations = join(paths.gamma, '.shelf.json');
  mkdirSync(relations);

  const scanned = json('scan', '--root', root, '--no-github');
  assert.equal(scanned.total, 3);
  assert.equal(scanned.warnings?.length, 1);
  assert.ok(scanned.warnings[0].includes(relations));
  assert.match(scanned.warnings[0], /EISDIR/);
  assert.deepEqual(json('list').items.map((item: { name: string }) => item.name), ['alpha', 'delta', 'gamma']);
});

test('scan warns for a dangling relation-file symlink instead of treating it as absent', t => {
  const { dir, root, paths, json } = fixture(t);
  const relations = join(paths.gamma, '.shelf.json');
  symlinkSync(join(dir, 'missing-relations.json'), relations);

  const scanned = json('scan', '--root', root, '--no-github');
  assert.equal(scanned.total, 3);
  assert.equal(scanned.warnings?.length, 1);
  assert.ok(scanned.warnings[0].includes(relations));
  assert.match(scanned.warnings[0], /ENOENT/);
});

test('scan warns for a permission-denied relation file without failing the scan', t => {
  if (!process.getuid || process.getuid() === 0) return t.skip('Requires non-root Unix file permissions.');
  const { root, paths, json } = fixture(t);
  const relations = join(paths.gamma, '.shelf.json');
  write(relations, JSON.stringify({ related: [{ repo: 'alpha' }] }));
  chmodSync(relations, 0);
  try {
    const scanned = json('scan', '--root', root, '--no-github');
    assert.equal(scanned.total, 3);
    assert.equal(scanned.warnings?.length, 1);
    assert.ok(scanned.warnings[0].includes(relations));
    assert.match(scanned.warnings[0], /EACCES/);
  } finally {
    chmodSync(relations, 0o600);
  }
});

test('scan follows readable symlinked relation files without warnings', t => {
  const { dir, root, paths, json } = fixture(t);
  const target = join(dir, 'shared-relations.json');
  write(target, JSON.stringify({ related: [{ repo: 'alpha', relation: 'Shared fixture relation' }] }));
  symlinkSync(target, join(paths.gamma, '.shelf.json'));

  const scanned = json('scan', '--root', root, '--no-github');
  assert.equal(scanned.warnings, undefined);
  assert.equal(json('related', 'gamma').items[0].name, 'alpha');
});

test('scan stays quiet when optional relation files are genuinely absent', t => {
  const { root, json } = fixture(t);
  const scanned = json('scan', '--root', root, '--no-github');
  assert.equal(scanned.warnings, undefined);
  assert.equal(scanned.total, 3);
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
  assert.deepEqual(gamma.items.map((item: RelatedItem) => [item.ref, item.name, item.direction, item.source, item.relation]), [
    ['acme/alpha', 'alpha', 'outgoing', 'repo', 'Consumes the alpha API'],
    ['https://github.com/acme/beta.git', 'beta', 'outgoing', 'repo', null],
    ['../../delta', 'delta', 'outgoing', 'repo', 'Shares a database schema'],
    ['github.com/acme/missing', null, 'outgoing', 'repo', 'Deploy scripts'],
  ]);
  assert.equal(gamma.items[2].path, paths.delta);

  const alpha = json('related', 'alpha');
  assert.deepEqual(alpha.items.map((item: RelatedItem) => [item.name, item.direction, item.relation]), [['gamma', 'incoming', 'Consumes the alpha API']]);
  assert.equal(json('show', 'alpha').related.length, 1);
});

test('relate records machine-local relations that survive rescans and win over repo files', t => {
  const { root, paths, run, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [{ repo: 'alpha', relation: 'From the repo file' }] }));
  json('scan', '--root', root);

  assert.deepEqual(json('relate', 'gamma', 'alpha', 'Mine'), { related: paths.gamma, to: paths.alpha, relation: 'Mine' });
  json('relate', 'delta', 'gamma');
  json('scan');
  assert.deepEqual(json('related', 'gamma').items.map((item: RelatedItem) => [item.name, item.direction, item.source, item.relation]), [
    ['alpha', 'outgoing', 'local', 'Mine'],
    ['delta', 'incoming', 'local', null],
  ]);

  json('relate', 'gamma', 'alpha', '--clear');
  assert.equal(json('related', 'gamma').items[0].source, 'repo');
  assert.equal(run('relate', 'gamma', 'gamma').status, 1);
  assert.equal(run('relate', 'gamma', 'missing').status, 1);
  assert.equal(run('relate', 'gamma', 'delta', '--clear').status, 1);
});

test('search finds both endpoints from a declared relation explanation', t => {
  const { root, paths, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [{ repo: 'alpha', relation: 'Shares FETTLE_SERVICE_SECRET' }] }));
  json('scan', '--root', root);

  assert.deepEqual(json('search', 'fettle_service_secret').items.map((item: { name: string }) => item.name), ['alpha', 'gamma']);
});

test('search finds machine-local relation explanations without rescanning', t => {
  const { root, json } = fixture(t);
  json('scan', '--root', root);
  json('relate', 'gamma', 'delta', 'Uses the local signing oracle');

  assert.deepEqual(json('search', 'signing oracle').items.map((item: { name: string }) => item.name), ['delta', 'gamma']);
});

test('search keeps unresolved declared relations on their declaring repository', t => {
  const { root, paths, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [{ repo: 'github.com/acme/missing', relation: 'Owns the unresolved beacon' }] }));
  json('scan', '--root', root);

  assert.deepEqual(json('search', 'unresolved beacon').items.map((item: { name: string }) => item.name), ['gamma']);
});

test('local relations replace declared explanations in search', t => {
  const { root, paths, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [{ repo: 'alpha', relation: 'Uses the stale repository phrase' }] }));
  json('scan', '--root', root);
  json('relate', 'gamma', 'alpha', 'Uses the current local phrase');

  assert.deepEqual(json('search', 'current local').items.map((item: { name: string }) => item.name), ['alpha', 'gamma']);
  assert.equal(json('search', 'stale repository').total, 0);
});

test('search requires every word across repository and relation text', t => {
  const { root, paths, json } = fixture(t);
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [{ repo: 'alpha', relation: 'Shares a tesseract archive' }] }));
  json('scan', '--root', root);

  assert.deepEqual(json('search', 'gamma tesseract').items.map((item: { name: string }) => item.name), ['gamma']);
  assert.equal(json('search', 'gamma tesseract missing').total, 0);
});

test('search deduplicates relation matches and ranks stronger repository matches first', t => {
  const { root, paths, json } = fixture(t);
  repo(root, 'constellation');
  repo(root, 'description-hit', { 'README.md': '# Description hit\n\nConstellation reference.' });
  write(join(paths.gamma, '.shelf.json'), JSON.stringify({ related: [
    { repo: 'alpha', relation: 'Constellation connection' },
    { repo: 'delta', relation: 'Constellation connection' },
  ] }));
  write(join(paths.delta, '.shelf.json'), JSON.stringify({ related: [{ repo: 'alpha', relation: 'Constellation connection' }] }));
  json('scan', '--root', root);

  assert.deepEqual(json('search', 'constellation').items.map((item: { name: string }) => item.name), ['constellation', 'description-hit', 'alpha', 'delta', 'gamma']);
});

test('schema describes the CLI offline and text output renders for people', t => {
  const { root, json, run } = fixture(t);
  assert.equal(json('schema').name, 'shelf');
  assert.match(json('search', '--help').command.description, /relation explanations/);
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
