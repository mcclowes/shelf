/**
 * ---
 * purpose: Describe Shelf's public command contract for offline introspection and help.
 * ---
 */
const arg = (name: string, description: string, required = false) => ({ name, type: 'string', description, required });
const flag = (name: string, description: string) => ({ name, type: 'boolean', description, required: false });

export const contract = {
  name: 'shelf', version: '0.4.0', description: 'Index your repositories so agents get context on other projects without walking the filesystem.',
  command_layout: 'flat', output: { tty: 'text', piped: 'json' },
  global_args: [
    { name: '--output', aliases: ['-o'], type: 'string', enum: ['auto', 'json', 'text'], default: 'auto', description: 'Output format.' },
    { name: '--limit', type: 'integer', default: 100, description: 'Maximum list results, between 1 and 10000.' },
    { name: '--help', aliases: ['-h'], type: 'boolean', description: 'Describe the command interface.' },
    { name: '--version', type: 'boolean', description: 'Show Shelf version.' },
    flag('--no-refresh', 'Use cached state without automatic scanning or agent skill updates.'),
  ],
  commands: [
    { name: 'scan', description: 'Rebuild the index from local roots and GitHub owners. Flags replace the saved roots or owners; without them the saved ones are reused. Reads files only; never runs anything inside a repository.', mutating: true, args: [
      arg('--root', 'Directory to search for Git repositories; repeatable. Defaults to ~/Development on first scan.'),
      arg('--github', 'GitHub user or organization to list through gh; repeatable.'),
      flag('--no-github', 'Stop scanning GitHub owners.'),
      { ...arg('--depth', 'How many directories deep to look under each root.'), type: 'integer', default: 4 },
    ] },
    { name: 'list', description: 'List indexed repositories with their descriptions. Creates a missing index or refreshes one older than 24 hours unless --no-refresh is set.', mutating: true, args: [flag('--undescribed', 'Only repositories with no description.')] },
    { name: 'search', description: 'Find repositories by name, description, topic, language, or relation explanations. Maintains the index and agent skills unless --no-refresh is set.', mutating: true, args: [arg('query', 'Search words; all must match.', true)] },
    { name: 'show', description: 'Show one repository: path, remote, branch, language, manifests, agent files, and related repositories. Maintains the index and agent skills unless --no-refresh is set.', mutating: true, args: [arg('repo', 'Id, name, owner/name, or path.', true)] },
    { name: 'describe', description: 'Set or clear a description override that survives rescans.', mutating: true, args: [arg('repo', 'Id, name, owner/name, or path.', true), arg('text', 'One-sentence description.'), flag('--clear', 'Remove the override.')] },
    { name: 'related', description: 'List repositories related to one, in both directions: those it declares in its .shelf.json, those declaring it, and your local relations. Local relations replace repo-file ones between the same pair. Maintains the index and agent skills unless --no-refresh is set.', mutating: true, args: [arg('repo', 'Id, name, owner/name, or path.', true)] },
    { name: 'relate', description: 'Record a relation on this machine only, from one repository to another. It survives rescans and moves.', mutating: true, args: [arg('repo', 'Id, name, owner/name, or path.', true), arg('other', 'The related repository.', true), arg('text', 'How they relate, from the first repository\'s side.'), flag('--clear', 'Remove the local relation.')] },
    { name: 'sync', description: 'Update Shelf guidance for detected Claude and Codex installations and saved custom destinations.', mutating: true, args: [arg('--skills-dir', 'Write and remember this destination instead. Defaults to detected agent directories, or ~/.claude/skills when none are detected.')] },
    { name: 'schema', description: 'Describe Shelf offline.', mutating: false, args: [] },
    { name: 'capabilities', description: 'Alias for Shelf schema introspection.', mutating: false, args: [] },
  ],
  errors: [{ kind: 'invalid_request', exit_code: 1, retryable: false, description: 'Invalid input, missing index, gh failure, or local I/O failure; read message for remediation.' }],
};
