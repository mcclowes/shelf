import { readFileSync } from 'node:fs';
const version = process.argv[2];
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
let section;
let fence;
for (const line of changelog.split('\n')) {
  const match = line.replace(/\r$/, '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  const run = match?.[1];
  const tail = match?.[2] ?? '';
  if (fence) {
    if (run && run[0] === fence[0] && run.length >= fence.length && /^[ \t]*$/.test(tail)) fence = undefined;
  } else if (run && (run[0] === '~' || !tail.includes('`'))) {
    fence = run;
  } else if (line.startsWith('## ')) {
    if (section) break;
    if (line.slice(3).startsWith(`[${version}]`)) section = [];
    continue;
  }
  section?.push(line);
}
if (!section) {
  console.error(`CHANGELOG.md has no section for ${version}`);
  process.exit(1);
}
const notes = section.join('\n').trim();
if (!notes) {
  console.error(`CHANGELOG.md section for ${version} has no release notes`);
  process.exit(1);
}
console.log(notes);
