/**
 * ---
 * purpose: Derive a repository description offline from its manifests, README, or agent files, without running anything.
 * ---
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DescriptionSource } from './store.ts';

export const maxDescription = 280;
export const agentFileNames = ['AGENTS.md', 'CLAUDE.md', '.clip/commands.md', '.saggar/commands.md'];
export const manifestNames = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Package.swift', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'deno.json'];
const maxReadBytes = 256 * 1024;

type Described = { description?: string; description_source?: DescriptionSource };

export function describeLocal(path: string): Described {
  const manifest = manifestDescription(path);
  if (manifest) return { description: manifest, description_source: 'manifest' };
  const readme = readmeFile(path);
  const paragraph = readme && firstParagraph(readText(join(path, readme)) ?? '');
  if (paragraph) return { description: paragraph, description_source: 'readme' };
  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const guidance = firstParagraph(readText(join(path, file)) ?? '', isAgentBoilerplate);
    if (guidance) return { description: guidance, description_source: 'agents' };
  }
  return {};
}

/** Agent files open with imports like `@AGENTS.md` or a stock line about what the file is for. */
const isAgentBoilerplate = (text: string) => text.startsWith('@') || /^this file (provides|gives|contains) guidance/i.test(text);

export const presentFiles = (path: string, names: string[]) => names.filter(name => existsSync(join(path, name)));

function manifestDescription(path: string): string | undefined {
  const pkg = readText(join(path, 'package.json'));
  if (pkg) {
    try {
      const description = JSON.parse(pkg).description;
      if (typeof description === 'string' && clean(description)) return clean(description);
    } catch {}
  }
  for (const file of ['Cargo.toml', 'pyproject.toml']) {
    const match = readText(join(path, file))?.match(/^description\s*=\s*"((?:[^"\\]|\\.)*)"/m);
    if (match && clean(match[1])) return clean(match[1]);
  }
  return undefined;
}

function readmeFile(path: string): string | undefined {
  try {
    return readdirSync(path).filter(name => /^readme(\.(md|markdown|txt|rst))?$/i.test(name)).sort().find(name => {
      const file = join(path, name);
      return existsSync(file) && statSync(file).isFile();
    });
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    const descriptor = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(maxReadBytes);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(descriptor, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      return buffer.toString('utf8', 0, length);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
}

function withoutCodeAndComments(markdown: string): string {
  let fence: string | undefined;
  let comment = false;
  return markdown.split('\n').map(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    const run = match?.[1];
    const tail = match?.[2] ?? '';
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length && /^[ \t]*$/.test(tail)) fence = undefined;
      return '\n';
    }
    if (!comment && run && (run[0] === '~' || !tail.includes('`'))) {
      fence = run;
      return '\n';
    }
    let cursor = 0;
    let text = '';
    for (const token of line.matchAll(/<!--|-->/g)) {
      if (!comment && token[0] === '<!--') {
        text += line.slice(cursor, token.index);
        comment = true;
      } else if (comment && token[0] === '-->') {
        cursor = token.index + 3;
        comment = false;
      }
    }
    return comment ? text : `${text}${line.slice(cursor)}\n`;
  }).join('');
}

/** The first prose paragraph, skipping front matter, headings, badges, images, HTML, code, and tables. */
export function firstParagraph(markdown: string, skip: (text: string) => boolean = () => false): string | undefined {
  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '');
  const body = withoutCodeAndComments(normalized);
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    if (!lines[0]) continue;
    if (/^(#|<|!\[|\[!\[|\||>|-{3,}|={3,}|\s*[-*+] |\d+\. )/.test(lines[0]) || /^[=-]+$/.test(lines[1] ?? '')) continue;
    const text = clean(lines.join(' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/(?<=[.!?])\s+[^.!?]*:\s*$/, ''));
    if (text && /[a-z]/i.test(text) && !skip(text)) return text;
  }
  return undefined;
}

/** Descriptions reach agents as data, so strip control characters and keep them short. */
export function clean(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxDescription) return flat;
  const cut = flat.slice(0, maxDescription - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > maxDescription / 2 ? cut.lastIndexOf(' ') : cut.length)}…`;
}
