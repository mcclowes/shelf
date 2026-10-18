import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function notesFixture(t: TestContext, changelog: string) {
  const root = mkdtempSync(join(tmpdir(), 'shelf-notes-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('./release-notes.mjs', import.meta.url), join(root, 'scripts/release-notes.mjs'));
  writeFileSync(join(root, 'CHANGELOG.md'), changelog);
  const run = (version = '1.2.3') => spawnSync(process.execPath, ['scripts/release-notes.mjs', version], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  return { root, run };
}

const emptySections = [
  ['empty', '## [1.2.3]\n\n## [1.2.2]\n- Older release.\n'],
  ['whitespace-only', '## [1.2.3]\n \t\r\n\t \n## [1.2.2]\n- Older release.\n'],
  ['final heading without a newline', '## [1.2.3]'],
] as const;

for (const [name, changelog] of emptySections) {
  test(`release notes reject sections with ${name} content without emitting notes`, t => {
    const { run } = notesFixture(t, changelog);
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /CHANGELOG\.md section for 1\.2\.3 has no release notes/);
  });
}

test('release notes select the exact version and preserve nested headings', t => {
  const notes = '- Fixed a bug.\n\n### Details\n\n- More context.';
  const { run } = notesFixture(t, `# Changelog\n\n## [1.2.30]\n- Different version.\n\n## [1.2.3-preview]\n- Prerelease.\n\n## [1.2.3] - 2026-10-16\n\n${notes}\n\n## [1.2.2]\n- Older release.\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${notes}\n`);
  assert.equal(result.stderr, '');
});

test('release notes retain the missing-section failure', t => {
  const { run } = notesFixture(t, '## [1.2.30]\n- Different version.\n');
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /CHANGELOG\.md has no section for 1\.2\.3/);
});

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const publicationStep = workflow.match(/      - name: Publish GitHub release\n[\s\S]*?        run: \|\n((?:          [^\n]*\n)+)/)?.[1];
assert.ok(publicationStep, 'Expected the existing publication shell step');
const publicationScript = publicationStep.replace(/^ {10}/gm, '');

for (const [name, changelog] of [...emptySections, ['valid', '## [1.2.3]\n\n- Shipped a fix.\n']]) {
  test(`the publication step ${name === 'valid' ? 'publishes valid notes' : `stops before publishing ${name} notes`}`, t => {
    const { root } = notesFixture(t, changelog);
    const bin = join(root, 'bin');
    const trace = join(root, 'publisher.json');
    mkdirSync(bin);
    mkdirSync(join(root, 'release'));
    writeFileSync(join(root, 'release/shelf-1.2.3.tar.gz'), 'Fixture archive');
    writeFileSync(join(root, 'release/shelf-1.2.3.tar.gz.sha256'), 'Fixture checksum');
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PUBLISH_TRACE, JSON.stringify(process.argv.slice(2)));\n');
    chmodSync(join(bin, 'gh'), 0o755);

    const result = spawnSync('bash', ['-e', '-c', publicationScript], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_REF_NAME: 'v1.2.3', PUBLISH_TRACE: trace },
    });

    assert.equal(result.error, undefined);
    if (name === 'valid') {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), [
        'release', 'create', 'v1.2.3', 'release/shelf-1.2.3.tar.gz', 'release/shelf-1.2.3.tar.gz.sha256', '--verify-tag', '--notes-file', 'release-notes.md',
      ]);
      assert.equal(readFileSync(join(root, 'release-notes.md'), 'utf8'), '- Shipped a fix.\n');
    } else {
      assert.equal(result.status, 1);
      assert.equal(existsSync(trace), false);
      assert.equal(readFileSync(join(root, 'release-notes.md'), 'utf8'), '');
    }
  });
}

const fencedBodies = [
  ['backticks', '- Example:\n\n```markdown\n## [9.9.9]\n- Example content.\n```\n\n### Details\n\n- Still this release.'],
  ['tildes and CRLF', '- Example:\r\n\r\n~~~markdown\r\n## [9.9.9]\r\n- Example content.\r\n~~~\r\n\r\n- Still this release.'],
  ['shorter embedded fences', '- Example:\n\n````markdown\n```\n## [9.9.9]\n- Example content.\n`````\n\n- Still this release.'],
  ['mismatched embedded fences', '- Example:\n\n```markdown\n~~~\n## [9.9.9]\n- Example content.\n```\n\n- Still this release.'],
  ['embedded fence runs with trailing text', '- Example:\n\n```markdown\n```not-a-close\n## [9.9.9]\n- Example content.\n```\n\n- Still this release.'],
  ['over-indented embedded fences', '- Example:\n\n```markdown\n    ```\n## [9.9.9]\n- Example content.\n```\n\n- Still this release.'],
  ['indented fences and closing whitespace', '- Example:\n\n   ~~~~markdown\n## [9.9.9]\n- Example content.\n ~~~~~ \t\n\n- Still this release.'],
  ['an unclosed fence', '- Example:\n\n```markdown\n## [9.9.9]\n- This is still code at the end of the document.'],
] as const;

for (const [name, notes] of fencedBodies) {
  test(`release notes preserve ${name} without treating code headings as sections`, t => {
    const newline = name === 'tildes and CRLF' ? '\r\n' : '\n';
    const nextRelease = name === 'an unclosed fence' ? '' : `${newline}${newline}## [1.2.2]${newline}- Older release.${newline}`;
    const { run } = notesFixture(t, `# Changelog${newline}${newline}## [1.2.3]${newline}${newline}${notes}${nextRelease}`);
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${notes}\n`);
    assert.equal(result.stderr, '');
  });
}

for (const fence of ['```', '~~~']) {
  test(`release selection ignores a matching heading inside a ${fence} preamble`, t => {
    const { run } = notesFixture(t, `# Changelog\n\n${fence}markdown\n## [1.2.3]\n- Example only.\n${fence}\n\n## [1.2.3]\n\n- Actual release.\n\n## [1.2.2]\n- Older release.\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '- Actual release.\n');
  });
}

test('a matching heading only inside a fence retains the missing-section failure', t => {
  const { run } = notesFixture(t, '```markdown\n## [1.2.3]\n- Example only.\n```\n');
  const result = run();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /CHANGELOG\.md has no section for 1\.2\.3/);
});

for (const opener of ['```invalid`info', '    ```']) {
  test(`a non-fence opening (${JSON.stringify(opener)}) does not hide the release heading`, t => {
    const { run } = notesFixture(t, `${opener}\n\n## [1.2.3]\n- Actual release.\n\n## [1.2.2]\n- Older release.\n`);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '- Actual release.\n');
  });
}

test('the publication step passes the complete fenced example to the publisher', t => {
  const notes = fencedBodies[0][1];
  const { root } = notesFixture(t, `## [1.2.3]\n\n${notes}\n\n## [1.2.2]\n- Older release.\n`);
  const bin = join(root, 'bin');
  const trace = join(root, 'publisher.json');
  mkdirSync(bin);
  mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'release/shelf-1.2.3.tar.gz'), 'Fixture archive');
  writeFileSync(join(root, 'release/shelf-1.2.3.tar.gz.sha256'), 'Fixture checksum');
  writeFileSync(join(bin, 'gh'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.PUBLISH_TRACE, JSON.stringify(process.argv.slice(2)));\n');
  chmodSync(join(bin, 'gh'), 0o755);
  const result = spawnSync('bash', ['-e', '-c', publicationScript], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: '', GITHUB_TOKEN: '', GITHUB_REF_NAME: 'v1.2.3', PUBLISH_TRACE: trace },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(trace, 'utf8')), [
    'release', 'create', 'v1.2.3', 'release/shelf-1.2.3.tar.gz', 'release/shelf-1.2.3.tar.gz.sha256', '--verify-tag', '--notes-file', 'release-notes.md',
  ]);
  assert.equal(readFileSync(join(root, 'release-notes.md'), 'utf8'), `${notes}\n`);
});
