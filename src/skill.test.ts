import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillText, syncSkill } from './skill.ts';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shelf-skill-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, 'skills');
  const { file } = syncSkill(skills);
  const marker = join(dirname(file), '.shelf-owned');
  return { root, skills, file, marker };
}

function snapshot(path: string): unknown {
  const entry = lstatSync(path);
  const metadata = { mode: entry.mode, inode: entry.ino };
  if (entry.isSymbolicLink()) return { ...metadata, link: readlinkSync(path) };
  if (entry.isDirectory()) return { ...metadata, children: readdirSync(path).sort().map(name => [name, snapshot(join(path, name))]) };
  return { ...metadata, content: readFileSync(path, 'utf8') };
}

test('skill sync refuses a linked output without overwriting its target', t => {
  const { root, skills, file, marker } = fixture(t);
  const target = join(root, 'manual.md');
  writeFileSync(target, 'Manually owned skill.\n');
  rmSync(file);
  symlinkSync(target, file);
  const before = lstatSync(file);
  const ownership = readFileSync(marker);

  assert.throws(() => syncSkill(skills), /not a regular file/);

  assert.equal(readFileSync(target, 'utf8'), 'Manually owned skill.\n');
  assert.equal(readlinkSync(file), target);
  assert.equal(lstatSync(file).ino, before.ino);
  assert.equal(lstatSync(file).mode, before.mode);
  assert.deepEqual(readFileSync(marker), ownership);
});

test('a linked ownership marker cannot authorize a skill refresh', t => {
  const { root, skills, file, marker } = fixture(t);
  const target = join(root, 'marker');
  const ownership = readFileSync(marker);
  writeFileSync(target, ownership);
  rmSync(marker);
  symlinkSync(target, marker);
  writeFileSync(file, 'Manual replacement.\n');
  const before = lstatSync(marker);

  assert.throws(() => syncSkill(skills), /not written by Shelf/);

  assert.equal(readFileSync(file, 'utf8'), 'Manual replacement.\n');
  assert.deepEqual(readFileSync(target), ownership);
  assert.equal(readlinkSync(marker), target);
  assert.equal(lstatSync(marker).ino, before.ino);
});

for (const kind of ['dangling link', 'current-text link', 'directory']) {
  test(`skill sync refuses a ${kind} output and preserves the complete fixture`, t => {
    const { root, skills, file } = fixture(t);
    const target = join(root, 'target');
    rmSync(file);
    if (kind === 'directory') {
      mkdirSync(file);
      writeFileSync(join(file, 'sentinel'), 'Manual directory.\n');
    } else {
      if (kind === 'current-text link') writeFileSync(target, skillText);
      symlinkSync(target, file);
    }
    writeFileSync(join(dirname(file), 'notes.md'), 'Keep unrelated notes.\n');
    const before = snapshot(root);

    assert.throws(() => syncSkill(skills), /not a regular file/);

    assert.deepEqual(snapshot(root), before);
  });
}

for (const kind of ['dangling link', 'directory']) {
  test(`skill sync refuses a ${kind} ownership marker without changing files`, t => {
    const { root, skills, file, marker } = fixture(t);
    rmSync(marker);
    if (kind === 'directory') mkdirSync(marker);
    else symlinkSync(join(root, 'missing-marker'), marker);
    writeFileSync(file, 'Manual replacement.\n');
    const before = snapshot(root);

    assert.throws(() => syncSkill(skills), /not written by Shelf/);

    assert.deepEqual(snapshot(root), before);
  });
}

for (const kind of ['directory link', 'dangling link', 'regular file']) {
  test(`skill sync refuses a Shelf ${kind} and preserves existing entries`, t => {
    const { root, skills, file } = fixture(t);
    const dir = dirname(file);
    const target = join(root, 'other-shelf');
    if (kind === 'directory link') {
      mkdirSync(target);
      writeFileSync(join(target, '.shelf-owned'), 'shelf-skill-v1\n');
      writeFileSync(join(target, 'SKILL.md'), 'Manual target.\n');
    }
    rmSync(dir, { recursive: true });
    if (kind === 'regular file') writeFileSync(dir, 'Manual file.\n');
    else symlinkSync(target, dir);
    const before = snapshot(root);

    assert.throws(() => syncSkill(skills), /not written by Shelf/);

    assert.deepEqual(snapshot(root), before);
  });
}

test('owned regular skills refresh, recreate missing output, and remain idempotent', t => {
  const { skills, file, marker } = fixture(t);
  const ownership = readFileSync(marker);
  assert.deepEqual(syncSkill(skills), { file, changed: false });
  writeFileSync(file, 'Outdated generated skill.\n');
  assert.deepEqual(syncSkill(skills), { file, changed: true });
  assert.equal(readFileSync(file, 'utf8'), skillText);
  rmSync(file);
  assert.deepEqual(syncSkill(skills), { file, changed: true });
  assert.deepEqual(syncSkill(skills), { file, changed: false });
  assert.deepEqual(readFileSync(marker), ownership);
});

test('explicit aliases for the parent skills directory support creation and refresh', t => {
  const { root, skills, file } = fixture(t);
  const alias = join(root, 'skills-alias');
  symlinkSync(skills, alias);
  rmSync(dirname(file), { recursive: true });
  const created = syncSkill(alias);
  assert.equal(created.changed, true);
  assert.equal(readFileSync(file, 'utf8'), skillText);
  writeFileSync(file, 'Outdated generated skill.\n');
  assert.deepEqual(syncSkill(alias), { file: created.file, changed: true });
  assert.deepEqual(syncSkill(alias), { file: created.file, changed: false });
  assert.equal(readlinkSync(alias), skills);
});

for (const name of ['SKILL.md', '.shelf-owned']) {
  test(`the CLI refuses a linked ${name} with a structured error`, t => {
    const { root, skills, file } = fixture(t);
    const entry = join(dirname(file), name);
    const target = join(root, 'manual-target');
    writeFileSync(target, name === '.shelf-owned' ? 'shelf-skill-v1\n' : 'Manual target.\n');
    rmSync(entry);
    symlinkSync(target, entry);
    writeFileSync(join(dirname(file), 'notes.md'), 'Keep unrelated notes.\n');
    const before = snapshot(root);

    const result = spawnSync(process.execPath, [new URL('./main.ts', import.meta.url).pathname, 'sync', '--skills-dir', skills], {
      cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, SHELF_HOME: join(root, 'config') },
    });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.kind, 'invalid_request');
    assert.match(JSON.parse(result.stderr).error.message, name === '.shelf-owned' ? /not written by Shelf/ : /not a regular file/);
    assert.deepEqual(snapshot(root), before);
  });
}

function skillCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [new URL('./main.ts', import.meta.url).pathname, ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: join(root, 'home'), SHELF_HOME: join(root, 'config') },
  });
}

for (const existing of [false, true]) {
  test(`empty skills directory preserves a ${existing ? 'previously owned' : 'fresh'} destination`, t => {
    const { root } = fixture(t);
    if (existing) {
      const { file } = syncSkill(root);
      writeFileSync(file, 'Previous generated fixture guidance.\n');
      chmodSync(file, 0o600);
      chmodSync(join(dirname(file), '.shelf-owned'), 0o640);
      writeFileSync(join(dirname(file), 'notes.md'), 'Keep fixture notes.\n');
    }
    const before = snapshot(root);

    const result = skillCli(root, 'sync', '--skills-dir', '');

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr).error, { kind: 'invalid_request', message: '--skills-dir must not be empty.' });
    assert.deepEqual(snapshot(root), before);
  });
}

test('empty skills directory is rejected by direct skill synchronization', t => {
  const { root } = fixture(t);
  const before = snapshot(root);
  const source = new URL('./skill.ts', import.meta.url).href;
  const script = `import assert from 'node:assert/strict';
const { syncSkill } = await import(${JSON.stringify(source)});
assert.throws(() => syncSkill(''), { message: '--skills-dir must not be empty.' });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HOME: join(root, 'home'), SHELF_HOME: join(root, 'config') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(snapshot(root), before);
});

test('non-empty skills directories retain defaults and literal destinations', t => {
  const { root } = fixture(t);
  for (const directory of [undefined, 'custom skills', '   ', '.']) {
    const options = directory === undefined ? [] : ['--skills-dir', directory];
    const destination = directory === undefined ? join(root, 'home/.claude/skills') : join(root, directory);
    const result = skillCli(root, 'sync', ...options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { file: join(destination, 'shelf/SKILL.md'), changed: true });
    assert.equal(readFileSync(join(destination, 'shelf/SKILL.md'), 'utf8'), skillText);
    const repeated = skillCli(root, 'sync', ...options);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), { file: join(destination, 'shelf/SKILL.md'), changed: false });
  }
});

test('empty skills directory preserves flag precedence and shortcuts', t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config/index.json'), 'invalid saved index\n');
  const before = snapshot(root);
  const unsupported = skillCli(root, 'list', '--skills-dir', '');
  assert.equal(unsupported.status, 1, unsupported.stderr);
  assert.equal(unsupported.stdout, '');
  assert.deepEqual(JSON.parse(unsupported.stderr).error, {
    kind: 'invalid_request', message: 'list does not accept --skills-dir. Run shelf list --help.',
  });
  for (const options of [[], ['sync', '--help'], ['sync', '--version']]) {
    const result = skillCli(root, ...options, '--skills-dir', '');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).name, 'shelf');
  }
  assert.deepEqual(snapshot(root), before);
});

for (const kind of ['symlink', 'directory']) {
  test(`skill synchronization refuses a ${kind} content fingerprint`, t => {
    const { root, skills, file } = fixture(t);
    const hash = join(dirname(file), '.shelf-content.sha256');
    rmSync(hash);
    if (kind === 'directory') mkdirSync(hash);
    else {
      const target = join(root, 'manual-fingerprint');
      writeFileSync(target, 'Keep manual state.\n');
      symlinkSync(target, hash);
    }
    const before = snapshot(root);
    assert.throws(() => syncSkill(skills, true), /not a regular content fingerprint/);
    assert.deepEqual(snapshot(root), before);
  });
}
