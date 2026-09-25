import { readFileSync } from 'node:fs';
const tag = process.argv[2];
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const contract = readFileSync(new URL('../src/contract.ts', import.meta.url), 'utf8');
const problems = [];
if (tag && tag !== `v${version}`) problems.push(`tag ${tag} does not match package.json version ${version}`);
if (!contract.includes(`version: '${version}'`)) problems.push(`src/contract.ts does not declare version ${version}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
