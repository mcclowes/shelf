import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clean, firstParagraph, maxDescription } from './describe.ts';
import { normalizeRemote } from './scan.ts';
import { searchRepos } from './repos.ts';

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
