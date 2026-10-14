import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function versionFixture(t: TestContext, contract: string) {
  const root = mkdtempSync(join(tmpdir(), 'shelf-version-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  copyFileSync(new URL('./check-version.mjs', import.meta.url), join(root, 'scripts/check-version.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.2.3' }));
  writeFileSync(join(root, 'src/contract.ts'), contract);
  return (...args: string[]) => spawnSync(process.execPath, ['scripts/check-version.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
}

test('release version check accepts the exported version with or without a matching tag', t => {
  const run = versionFixture(t, "export const contract = { version: '1.2.3' };\n");
  for (const args of [[], ['v1.2.3']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('release version check accepts equivalent contract formatting', t => {
  const run = versionFixture(t, 'export const contract = { version:\n  "1.2.3" };\n');
  const result = run('v1.2.3');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('a matching comment cannot hide a mismatched exported version', t => {
  const run = versionFixture(t, "// Previous version: '1.2.3'\nexport const contract = { version: '1.2.2' };\n");
  const result = run('v1.2.3');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /src\/contract\.ts does not declare version 1\.2\.3/);
});

test('release version check retains tag mismatch diagnostics', t => {
  const run = versionFixture(t, "export const contract = { version: '1.2.3' };\n");
  const result = run('v1.2.4');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /tag v1\.2\.4 does not match package\.json version 1\.2\.3/);
});

test('release version check reports tag and contract mismatches together', t => {
  const run = versionFixture(t, "export const contract = { version: '1.2.2' };\n");
  const result = run('v1.2.4');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tag v1\.2\.4 does not match package\.json version 1\.2\.3/);
  assert.match(result.stderr, /src\/contract\.ts does not declare version 1\.2\.3/);
});
