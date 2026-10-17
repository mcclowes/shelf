import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clean, describeLocal, firstParagraph, maxDescription } from './describe.ts';
import { normalizeRemote } from './scan.ts';
import { searchRepos } from './repos.ts';

function metadataFixture(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'shelf-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const metadataReadLimit = 256 * 1024;

test('oversized sparse README metadata retains precedence over agent guidance', t => {
  const root = metadataFixture(t);
  const readme = join(root, 'README.md');
  writeFileSync(readme, '# Tool\n\nA repository browser.\n\n');
  truncateSync(readme, 2 ** 31);
  writeFileSync(join(root, 'AGENTS.md'), 'Fallback agent guidance.\n');

  assert.deepEqual(describeLocal(root), { description: 'A repository browser.', description_source: 'readme' });
});

for (const [name, content, source] of [
  ['package.json', JSON.stringify({ description: 'Metadata describes this project.' }).padEnd(metadataReadLimit, ' '), 'manifest'],
  ['Cargo.toml', 'description = "Metadata describes this project."\n', 'manifest'],
  ['pyproject.toml', 'description = "Metadata describes this project."\n', 'manifest'],
  ['AGENTS.md', '# Guidance\n\nMetadata describes this project.\n\n', 'agents'],
  ['CLAUDE.md', '# Guidance\n\nMetadata describes this project.\n\n', 'agents'],
] as const) {
  test(`oversized sparse ${name} metadata preserves description precedence`, t => {
    const root = metadataFixture(t);
    writeFileSync(join(root, 'README.md'), source === 'manifest' ? 'Fallback README.\n' : '# Heading only\n');
    const file = join(root, name);
    writeFileSync(file, content);
    truncateSync(file, 2 ** 31);

    assert.deepEqual(describeLocal(root), { description: 'Metadata describes this project.', description_source: source });
  });
}

for (const withinLimit of [true, false]) {
  test(`prose ${withinLimit ? 'within' : 'beyond'} the metadata prefix retains the read boundary`, t => {
    const root = metadataFixture(t);
    const prose = 'A visible description.\n';
    const padding = metadataReadLimit - (withinLimit ? Buffer.byteLength(prose) : 0);
    writeFileSync(join(root, 'README.md'), '\n'.repeat(padding) + prose);
    writeFileSync(join(root, 'AGENTS.md'), 'Agent fallback.\n');

    assert.deepEqual(describeLocal(root), withinLimit
      ? { description: 'A visible description.', description_source: 'readme' }
      : { description: 'Agent fallback.', description_source: 'agents' });
  });
}

test('the metadata byte boundary preserves existing partial UTF-8 decoding', t => {
  const root = metadataFixture(t);
  writeFileSync(join(root, 'README.md'), '\n'.repeat(metadataReadLimit - Buffer.byteLength('Prose ') - 1) + 'Prose é');
  assert.deepEqual(describeLocal(root), { description: 'Prose �', description_source: 'readme' });
  writeFileSync(join(root, 'README.md'), 'Café tools for 日本語 documentation.\n');
  assert.deepEqual(describeLocal(root), { description: 'Café tools for 日本語 documentation.', description_source: 'readme' });
});

for (const kind of ['empty', 'missing', 'read error']) {
  test(`${kind} README metadata retains ordinary agent fallback`, t => {
    const root = metadataFixture(t);
    if (kind === 'empty') writeFileSync(join(root, 'README.md'), '');
    if (kind === 'read error') mkdirSync(join(root, 'README.md'));
    writeFileSync(join(root, 'AGENTS.md'), 'Agent fallback.\n');
    assert.deepEqual(describeLocal(root), { description: 'Agent fallback.', description_source: 'agents' });
  });
}

for (const failRead of [false, true]) {
  test(`metadata descriptors close after ${failRead ? 'a read failure' : 'short reads'}`, t => {
    const root = metadataFixture(t);
    writeFileSync(join(root, 'README.md'), 'A repository browser with a longer description.\n');
    if (!failRead) truncateSync(join(root, 'README.md'), 2 ** 31);
    writeFileSync(join(root, 'AGENTS.md'), 'Agent fallback.\n');
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const root = ${JSON.stringify(root)};
      const opened = new Map();
      let count = 0;
      let closed = 0;
      let bytes = 0;
      const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
      fs.openSync = (file, ...args) => {
        const descriptor = original.open(file, ...args);
        if (String(file).startsWith(root + '/')) { opened.set(descriptor, String(file)); count++; }
        return descriptor;
      };
      fs.readSync = (descriptor, buffer, offset, length, position) => {
        if (opened.has(descriptor)) {
          if (${failRead} && opened.get(descriptor).endsWith('/README.md')) throw new Error('fixture read failure');
          length = Math.min(length, 7);
        }
        const count = original.read(descriptor, buffer, offset, length, position);
        if (opened.has(descriptor)) bytes += count;
        return count;
      };
      fs.closeSync = descriptor => {
        const result = original.close(descriptor);
        if (opened.delete(descriptor)) closed++;
        return result;
      };
      syncBuiltinESMExports();
      const { describeLocal } = await import(${JSON.stringify(new URL('./describe.ts', import.meta.url).href)});
      const result = describeLocal(root);
      process.stdout.write(JSON.stringify({ result, count, closed, bytes, active: opened.size }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: root, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.deepEqual(report.result, failRead
      ? { description: 'Agent fallback.', description_source: 'agents' }
      : { description: 'A repository browser with a longer description.', description_source: 'readme' });
    assert.equal(report.count, failRead ? 2 : 1);
    assert.equal(report.closed, report.count);
    assert.equal(report.bytes, failRead ? Buffer.byteLength('Agent fallback.\n') : metadataReadLimit);
    assert.equal(report.active, 0);
  });
}

test('first paragraph skips headings, badges, front matter, code, and lists', () => {
  const readme = [
    '---', 'title: x', '---', '# Tool', '',
    '[![CI](https://x/badge.svg)](https://x) [![npm](https://y)](https://y)', '',
    '<p align="center"><img src="logo.png"></p>', '',
    '```sh', 'npm i tool', '', 'tool run', '```', '',
    '- a list item', '',
    'A [small](https://z) tool for\nrunning things.', '', 'Second paragraph.',
  ].join('\n');
  assert.equal(firstParagraph(readme), 'A small tool for running things.');
});

test('first paragraph skips setext headings and returns undefined without prose', () => {
  assert.equal(firstParagraph('Title\n=====\n\nBody text.'), 'Body text.');
  assert.equal(firstParagraph('# Only a heading\n\n![logo](x.png)'), undefined);
  assert.equal(firstParagraph('A map of venues. It has three parts:\n\n1. One'), 'A map of venues.');
});

test('clean strips control characters and caps length at a word boundary', () => {
  assert.equal(clean('a\u0007b\n\n  c'), 'a b c');
  const long = clean('word '.repeat(200));
  assert.ok(long.length <= maxDescription);
  assert.ok(long.endsWith('word…'));
});

test('remotes normalize to host/owner/name', () => {
  assert.equal(normalizeRemote('git@github.com:Acme/app.git'), 'github.com/Acme/app');
  assert.equal(normalizeRemote('https://github.com/acme/app'), 'github.com/acme/app');
  assert.equal(normalizeRemote('https://token@github.com/acme/app.git/'), 'github.com/acme/app');
  assert.equal(normalizeRemote('ssh://git@gitlab.example.com:2222/group/sub/app.git'), 'gitlab.example.com/group/sub/app');
  assert.equal(normalizeRemote('/srv/git/app.git'), undefined);
});

test('search requires every word and ranks name hits first', () => {
  const repos = [
    { id: '1', name: 'docs', description: 'Documentation for the billing api' },
    { id: '2', name: 'billing-api', description: 'Payments service' },
    { id: '3', name: 'web', description: 'Marketing site' },
  ];
  assert.deepEqual(searchRepos(repos, 'billing').map(repo => repo.id), ['2', '1']);
  assert.deepEqual(searchRepos(repos, 'billing docs').map(repo => repo.id), ['1']);
  assert.throws(() => searchRepos(repos, '  '), /query/);
});

test('search matches plurals and simple variants in either direction', () => {
  const repos = [
    { id: '1', name: 'clipped', description: 'A clipboard manager' },
    { id: '2', name: 'libs', description: 'Shared libraries for testing' },
  ];
  assert.deepEqual(searchRepos(repos, 'clipboards').map(repo => repo.id), ['1']);
  assert.deepEqual(searchRepos(repos, 'library').map(repo => repo.id), ['2']);
  assert.deepEqual(searchRepos(repos, 'tests').map(repo => repo.id), ['2']);
  assert.deepEqual(searchRepos(repos, 'managers').map(repo => repo.id), ['1']);
  assert.deepEqual(searchRepos(repos, 'class').map(repo => repo.id), []);
});
