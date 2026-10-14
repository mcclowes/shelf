import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function packagingFixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shelf-packaging-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, 'temporary');
  const neighbor = join(temporary, 'shelf-release-unrelated');
  mkdirSync(neighbor, { recursive: true });
  writeFileSync(join(neighbor, 'keep.txt'), 'preserve');
  mkdirSync(join(root, 'scripts'));
  cpSync(new URL('./package-release.mjs', import.meta.url), join(root, 'scripts', 'package-release.mjs'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'main.js'), 'console.log("fixture Shelf");\n');
  chmodSync(join(root, 'dist', 'main.js'), 0o755);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3', type: 'module' }));
  writeFileSync(join(root, 'README.md'), 'Fixture readme\n');
  writeFileSync(join(root, 'LICENSE'), 'Fixture license\n');
  const run = (path = process.env.PATH) => spawnSync(process.execPath, ['scripts/package-release.mjs'], {
    cwd: root,
    env: { ...process.env, SHELF_HOME: join(root, 'shelf-state'), TMPDIR: temporary, TMP: temporary, TEMP: temporary, PATH: path },
    encoding: 'utf8',
    timeout: 10000,
  });
  const assertClean = () => {
    assert.deepEqual(readdirSync(temporary), ['shelf-release-unrelated']);
    assert.equal(readFileSync(join(neighbor, 'keep.txt'), 'utf8'), 'preserve');
  };
  return { root, run, assertClean };
}

test('release packaging preserves its archive and checksum while removing its staging directory', t => {
  const { root, run, assertClean } = packagingFixture(t);
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const archive = join(root, 'release', 'shelf-1.2.3.tar.gz');
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8'), `${digest}  shelf-1.2.3.tar.gz\n`);
  assert.equal(result.stdout, `${archive}\n${digest}\n`);
  const extracted = join(root, 'extracted');
  mkdirSync(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  const contents = join(extracted, 'shelf-1.2.3');
  assert.deepEqual(readdirSync(contents).sort(), ['LICENSE', 'README.md', 'dist', 'package.json']);
  assert.equal(readFileSync(join(contents, 'dist', 'main.js'), 'utf8'), 'console.log("fixture Shelf");\n');
  assert.equal(statSync(join(contents, 'dist', 'main.js')).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(contents, 'README.md'), 'utf8'), 'Fixture readme\n');
  assert.equal(readFileSync(join(contents, 'LICENSE'), 'utf8'), 'Fixture license\n');
  assert.equal(readFileSync(join(contents, 'package.json'), 'utf8'), readFileSync(join(root, 'package.json'), 'utf8'));
  assertClean();
});

test('release packaging preserves missing-input errors and removes staging', t => {
  const { root, run, assertClean } = packagingFixture(t);
  rmSync(join(root, 'dist'), { recursive: true });
  const result = run();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(root, 'release', 'shelf-1.2.3.tar.gz.sha256')), false);
  assertClean();
});

test('release packaging preserves tar errors and removes staging', t => {
  const { root, run, assertClean } = packagingFixture(t);
  const emptyPath = join(root, 'empty-bin');
  mkdirSync(emptyPath);
  const result = run(emptyPath);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /spawnSync tar ENOENT/);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(root, 'release', 'shelf-1.2.3.tar.gz.sha256')), false);
  assertClean();
});
