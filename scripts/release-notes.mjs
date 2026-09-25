import { readFileSync } from 'node:fs';
const version = process.argv[2];
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const section = changelog.split(/^## /m).find((part) => part.startsWith(`[${version}]`));
if (!section) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
console.log(section.slice(section.indexOf('\n') + 1).trim());
