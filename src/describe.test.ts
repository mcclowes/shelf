import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
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

for (const name of ['package.json', 'Cargo.toml', 'pyproject.toml', 'AGENTS.md', 'CLAUDE.md']) {
  test(`a FIFO ${name} does not block description fallback`, t => {
    if (process.platform === 'win32') return t.skip('Requires POSIX named pipes.');
    const root = metadataFixture(t);
    const file = join(root, name);
    const created = spawnSync('mkfifo', [file], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    const before = lstatSync(file);
    const manifest = ['package.json', 'Cargo.toml', 'pyproject.toml'].includes(name);
    if (manifest) writeFileSync(join(root, 'README.md'), 'README fallback.\n');
    if (name === 'AGENTS.md') writeFileSync(join(root, 'CLAUDE.md'), 'Agent fallback.\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { describeLocal } from ${JSON.stringify(new URL('./describe.ts', import.meta.url).href)};
      console.log(JSON.stringify(describeLocal(${JSON.stringify(root)})));
    `], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env: { ...process.env, SHELF_HOME: join(root, 'config') } });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), manifest
      ? { description: 'README fallback.', description_source: 'readme' }
      : name === 'AGENTS.md' ? { description: 'Agent fallback.', description_source: 'agents' } : {});
    const after = lstatSync(file);
    assert.ok(after.isFIFO());
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
  });
}

test('a regular manifest symlink retains its description and precedence', t => {
  const root = metadataFixture(t);
  const target = join(root, 'shared-package.json');
  const file = join(root, 'package.json');
  const content = JSON.stringify({ description: 'Manifest description.' });
  writeFileSync(target, content);
  symlinkSync(target, file);
  writeFileSync(join(root, 'README.md'), 'README fallback.\n');
  const before = lstatSync(file);

  assert.deepEqual(describeLocal(root), { description: 'Manifest description.', description_source: 'manifest' });
  assert.equal(readFileSync(target, 'utf8'), content);
  assert.equal(readlinkSync(file), target);
  assert.equal(lstatSync(file).ino, before.ino);
  assert.equal(lstatSync(file).mode, before.mode);
});

test('a README directory does not mask a regular README.md description', t => {
  const root = metadataFixture(t);
  mkdirSync(join(root, 'README'));
  writeFileSync(join(root, 'README.md'), 'A repository browser.\n');
  writeFileSync(join(root, 'AGENTS.md'), 'Agent fallback.\n');

  assert.deepEqual(describeLocal(root), { description: 'A repository browser.', description_source: 'readme' });
});

for (const kind of ['directory link', 'dangling link', 'cyclic link']) {
  test(`a README ${kind} does not mask a regular README.md`, t => {
    const root = metadataFixture(t);
    const candidate = join(root, 'README');
    const target = kind === 'cyclic link' ? candidate : join(root, 'target');
    if (kind === 'directory link') {
      mkdirSync(target);
      writeFileSync(join(target, 'sentinel'), 'Manual target.\n');
    }
    symlinkSync(target, candidate);
    writeFileSync(join(root, 'README.md'), 'A repository browser.\n');
    writeFileSync(join(root, 'AGENTS.md'), 'Agent fallback.\n');
    const before = lstatSync(candidate);

    assert.deepEqual(describeLocal(root), { description: 'A repository browser.', description_source: 'readme' });

    assert.equal(readlinkSync(candidate), target);
    assert.equal(lstatSync(candidate).ino, before.ino);
    assert.equal(lstatSync(candidate).mode, before.mode);
    if (kind === 'directory link') assert.equal(readFileSync(join(target, 'sentinel'), 'utf8'), 'Manual target.\n');
    rmSync(join(root, 'README.md'));
    assert.deepEqual(describeLocal(root), { description: 'Agent fallback.', description_source: 'agents' });
  });
}

test('regular README links preserve sorted precedence and manifest descriptions still win', t => {
  const root = metadataFixture(t);
  const target = join(root, 'manual-target');
  const content = 'The first sorted README.\n';
  writeFileSync(target, content);
  symlinkSync(target, join(root, 'README'));
  writeFileSync(join(root, 'README.md'), 'The second README.\n');
  writeFileSync(join(root, 'AGENTS.md'), 'Agent fallback.\n');
  assert.deepEqual(describeLocal(root), { description: 'The first sorted README.', description_source: 'readme' });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ description: 'Manifest description.' }));
  assert.deepEqual(describeLocal(root), { description: 'Manifest description.', description_source: 'manifest' });
  assert.equal(readFileSync(target, 'utf8'), content);
  assert.equal(readlinkSync(join(root, 'README')), target);
});

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

test('first paragraph skips four-space installation code before prose', () => {
  assert.equal(firstParagraph('# Tool\n\n    npm install example\n\nA repository browser.'), 'A repository browser.');
});

for (const [name, markdown, expected] of [
  ['tab-indented code', '\tnpm install example\n\nA repository browser.', 'A repository browser.'],
  ['mixed space and tab code', ' \tnpm install example\n\nA repository browser.', 'A repository browser.'],
  ['three spaces before a tab', '   \tnpm install example\n\nA repository browser.', 'A repository browser.'],
  ['deeply indented code', '        npm install example\n\nA repository browser.', 'A repository browser.'],
  ['prose immediately after code', '    npm install example\nA repository browser.', 'A repository browser.'],
  ['blank-separated code chunks', '    npm install example\n\n\tnpm run example\nA repository browser.', 'A repository browser.'],
  ['code-only metadata', '    npm install example\n\n\tnpm run example\n', undefined],
  ['one-space prose', ' A repository browser.', 'A repository browser.'],
  ['two-space prose', '  A repository browser.', 'A repository browser.'],
  ['three-space prose', '   A repository browser.', 'A repository browser.'],
  ['four-space continuation', 'A repository browser\n    with indented continuation.', 'A repository browser with indented continuation.'],
  ['tab continuation', 'A repository browser\n\twith indented continuation.', 'A repository browser with indented continuation.'],
  ['leading blank lines', '\n    npm install example\n\nA repository browser.', 'A repository browser.'],
] as const) {
  test(`indented metadata handles ${name}`, () => {
    assert.equal(firstParagraph(markdown), expected);
  });
}

for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
  test(`${name} descriptions skip leading indented code through describeLocal`, t => {
    const root = metadataFixture(t);
    writeFileSync(join(root, 'README.md'), '    Code-only README example.\n');
    if (name === 'CLAUDE.md') writeFileSync(join(root, 'AGENTS.md'), '\tCode-only agent example.\n');
    writeFileSync(join(root, name), '# Tool\n\n    npm install example\n\nA repository browser.\n');

    assert.deepEqual(describeLocal(root), {
      description: 'A repository browser.', description_source: name === 'README.md' ? 'readme' : 'agents',
    });
  });
}

test('first paragraph skips tilde-fenced examples before prose', () => {
  assert.equal(firstParagraph('~~~sh\nnpm install example\n~~~\n\nA repository browser.'), 'A repository browser.');
});

for (const [name, lines, expected] of [
  ['long backticks', ['````markdown', '```sh', 'Example code.', '```', '````', 'A repository browser.'], 'A repository browser.'],
  ['long tildes', ['~~~~', '~~~sh', 'Example code.', '~~~', '~~~~', 'A repository browser.'], 'A repository browser.'],
  ['mismatched markers', ['```', '~~~', 'Example code.', '```', 'A repository browser.'], 'A repository browser.'],
  ['closing text', ['~~~', '~~~ trailing text', 'Example code.', '~~~', 'A repository browser.'], 'A repository browser.'],
  ['longer closing marker and whitespace', ['```', 'Example code.', '````` \t', 'A repository browser.'], 'A repository browser.'],
  ['indented fences', ['   ~~~sh', 'Example code.', ' ~~~', 'A repository browser.'], 'A repository browser.'],
  ['overindented closing marker', ['~~~', '    ~~~', 'Example code.', '~~~', 'A repository browser.'], 'A repository browser.'],
  ['tilde info containing backticks', ['~~~sh `example`', 'Example code.', '~~~', 'A repository browser.'], 'A repository browser.'],
  ['literal comment syntax inside code', ['~~~', '<!--', '~~~', 'A repository browser.'], 'A repository browser.'],
  ['fence syntax inside HTML comments', ['<!--', '~~~', '-->', 'A repository browser.'], 'A repository browser.'],
  ['adjacent following prose', ['~~~', 'Example code.', '~~~', 'A repository browser.'], 'A repository browser.'],
  ['adjacent preceding prose', ['A repository browser.', '~~~', 'Example code.', '~~~', 'Unrelated following prose.'], 'A repository browser.'],
  ['unclosed backticks', ['# Heading', '', '````', '```', 'Example code.'], undefined],
  ['unclosed tildes', ['# Heading', '', '~~~', 'Example code.', '', 'Still code.'], undefined],
] as const) {
  test(`fenced metadata handles ${name}`, () => {
    assert.equal(firstParagraph(lines.join('\n')), expected);
  });
}

test('invalid backtick info and inline markers remain ordinary paragraph text', () => {
  assert.equal(firstParagraph('```not`a`fence\nA repository browser.'), '```not`a`fence A repository browser.');
  assert.equal(firstParagraph('A ``` marker in prose.\nStill prose.'), 'A ``` marker in prose. Still prose.');
});

for (const ending of ['\r\n', '\r']) {
  test(`fenced metadata handles ${JSON.stringify(ending)} line endings`, () => {
    assert.equal(firstParagraph(['~~~', 'Example code.', '~~~', 'A repository browser.'].join(ending)), 'A repository browser.');
  });
}

test('paragraph rejection keeps prose on opposite sides of a fence separate', () => {
  const seen: string[] = [];
  const description = firstParagraph('Skip this boilerplate.\n~~~\nExample code.\n~~~\nA repository browser.', text => {
    seen.push(text);
    return text.startsWith('Skip');
  });
  assert.equal(description, 'A repository browser.');
  assert.deepEqual(seen, ['Skip this boilerplate.', 'A repository browser.']);
});

test('inline multiline HTML comments retain the surrounding prose paragraph', () => {
  assert.equal(firstParagraph('A <!-- hidden\n~~~\ntext -->repository browser.'), 'A repository browser.');
});

test('a leading UTF-8 signature does not expose fenced code as prose', () => {
  assert.equal(firstParagraph('\uFEFF```sh\nExample code.\n```\nA repository browser.'), 'A repository browser.');
});

test('signature-prefixed frontmatter with blank lines and CRLF remains metadata', () => {
  const markdown = '\uFEFF---\r\ntitle: hidden\r\n\r\nnote: metadata\r\nvalue: hidden\r\n\r\n---\r\n\r\n~~~sh\r\nExample code.\r\n~~~\r\nA repository browser.';
  assert.equal(firstParagraph(markdown), 'A repository browser.');
});

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
