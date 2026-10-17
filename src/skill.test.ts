import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillText, syncSkill } from './skill.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'shelf-skill-'));
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
