import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverride, mergeRepos } from './repos.ts';
import { identityKey, overrideKey, type Repo } from './store.ts';

test('GitHub casing merges remote metadata into the existing local clone', () => {
  const local: Repo = { id: '/private/alpha', path: '/private/alpha', name: 'alpha', remote: 'github.com/acme/alpha', branch: 'main', agent_files: ['AGENTS.md'] };
  const remote: Repo = { id: 'github.com/Acme/Alpha', name: 'Alpha', remote: 'github.com/Acme/Alpha', description: 'GitHub description.', description_source: 'github', github: { url: 'https://github.com/Acme/Alpha', private: true, archived: false, fork: false } };

  assert.deepEqual(mergeRepos([local], [remote], {}), [{
    ...local, remote: remote.remote, description: remote.description, description_source: 'github', github: remote.github,
  }]);
});

test('repeated GitHub results retain one remote-only entry with its original ID and name', () => {
  const first: Repo = { id: 'github.com/Acme/Alpha', name: 'Alpha', remote: 'github.com/Acme/Alpha' };
  const repeated: Repo = { id: 'github.com/acme/alpha', name: 'alpha', remote: 'github.com/acme/alpha' };
  assert.deepEqual(mergeRepos([], [first, repeated, first], {}), [first]);
});

test('legacy mixed-case GitHub description keys remain effective', () => {
  const repo: Repo = { id: '/private/alpha', name: 'alpha', remote: 'github.com/acme/alpha' };
  assert.deepEqual(applyOverride(repo, { 'github.com/Acme/Alpha': 'Legacy description.' }), {
    ...repo, description: 'Legacy description.', description_source: 'override',
  });
});

test('non-GitHub remotes and local paths retain their case boundaries', () => {
  for (const key of ['gitlab.example.com/Acme/Alpha', '/Code/Alpha', '/code/alpha']) assert.equal(identityKey(key), key);
  const local: Repo = { id: '/Code/Alpha', path: '/Code/Alpha', name: 'alpha', remote: 'gitlab.example.com/acme/alpha' };
  const remote: Repo = { id: 'gitlab.example.com/Acme/Alpha', name: 'Alpha', remote: 'gitlab.example.com/Acme/Alpha' };
  assert.deepEqual(mergeRepos([local], [remote], {}).map(repo => repo.id).sort(), [local.id, remote.id].sort());
  assert.equal(overrideKey(local), local.remote);
  assert.deepEqual(applyOverride(local, { 'gitlab.example.com/Acme/Alpha': 'Other repository.' }), local);
  const pathOnly: Repo = { id: '/Code/Alpha', path: '/Code/Alpha', name: 'alpha' };
  assert.deepEqual(applyOverride(pathOnly, { '/code/alpha': 'Other path.' }), pathOnly);
  assert.equal(identityKey('GITHUB.COM/Acme/Alpha'), 'github.com/acme/alpha');
});
