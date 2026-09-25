/**
 * ---
 * purpose: Derive a repository description offline from its manifests or README, without running anything.
 * ---
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DescriptionSource } from './store.ts';

export const maxDescription = 280;
export const agentFileNames = ['AGENTS.md', 'CLAUDE.md', '.clip/commands.md'];
export const manifestNames = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'Package.swift', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'mix.exs', 'deno.json'];
const maxReadBytes = 256 * 1024;

type Described = { description?: string; description_source?: DescriptionSource };

export function describeLocal(path: string): Described {
  const manifest = manifestDescription(path);
  if (manifest) return { description: manifest, description_source: 'manifest' };
  const readme = readmeFile(path);
  const paragraph = readme && firstParagraph(readText(join(path, readme)) ?? '');
  return paragraph ? { description: paragraph, description_source: 'readme' } : {};
}

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
    return readdirSync(path).filter(name => /^readme(\.(md|markdown|txt|rst))?$/i.test(name)).sort()[0];
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file).subarray(0, maxReadBytes).toString('utf8');
  } catch {
    return undefined;
  }
}

/** The first prose paragraph, skipping front matter, headings, badges, images, HTML, code, and tables. */
export function firstParagraph(markdown: string): string | undefined {
  const body = markdown.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n/, '').replace(/<!--[\s\S]*?-->/g, '');
  let fenced = false;
  for (const block of body.split(/\n\s*\n/)) {
    const lines = block.trim().split('\n');
    const fences = lines.filter(line => line.trimStart().startsWith('```')).length;
    const wasFenced = fenced;
    if (fences % 2) fenced = !fenced;
    if (wasFenced || fences || !lines[0]) continue;
    if (/^(#|<|!\[|\[!\[|\||>|-{3,}|={3,}|\s*[-*+] |\d+\. )/.test(lines[0]) || /^[=-]+$/.test(lines[1] ?? '')) continue;
    const text = clean(lines.join(' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    if (text && /[a-z]/i.test(text)) return text;
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
