/**
 * ---
 * purpose: Bootstrap and refresh Shelf's index and agent guidance when operational commands run.
 * related:
 *   - ./commands.ts - Supplies the scan operation and dispatches validated commands.
 * ---
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillDirectories, syncAutomaticSkills } from './skill.ts';
import { withStateLock } from './lock.ts';
import { readConfig, readIndex, shelfHome, writeJson } from './store.ts';

const queries = new Set(['list', 'search', 'show', 'related']);
const indexMaxAgeMs = 24 * 60 * 60 * 1000;
const retryDelayMs = 5 * 60 * 1000;

export function warn(error: unknown) {
  process.stderr.write(`${JSON.stringify({ warning: { kind: 'maintenance_failed', message: error instanceof Error ? error.message : String(error) } })}\n`);
}

function refreshIndex(scan: () => unknown) {
  const index = existsSync(join(shelfHome(), 'index.json')) ? readIndex() : undefined;
  const age = index ? Date.now() - Date.parse(index.scanned_at) : NaN;
  if (age >= 0 && age < indexMaxAgeMs) return;
  const retry = join(shelfHome(), 'refresh.json');
  if (index && existsSync(retry)) {
    try {
      const { failed_at } = JSON.parse(readFileSync(retry, 'utf8'));
      const elapsed = Date.now() - Date.parse(failed_at);
      if (elapsed >= 0 && elapsed < retryDelayMs) return;
    } catch { /* A damaged retry timestamp must not prevent a refresh. */ }
  }
  try {
    scan();
  } catch (error) {
    if (!index) throw error;
    warn(error);
    try { writeJson(retry, { failed_at: new Date().toISOString() }); } catch { /* Cached results remain usable when state is read-only. */ }
  }
}

export async function maintain<T>(name: string, cachedOnly: boolean, run: () => T, scan: () => unknown): Promise<T> {
  const query = queries.has(name);
  if (['help', 'schema', 'capabilities'].includes(name) || (cachedOnly && query)) return run();
  return withStateLock(() => {
    if (query && !cachedOnly) refreshIndex(scan);
    const result = run();
    if (!cachedOnly && name !== 'sync') {
      syncAutomaticSkills(skillDirectories(readConfig().skill_dirs), warn);
    }
    return result;
  }, query && existsSync(join(shelfHome(), 'index.json')) ? error => {
    if (error) warn(error);
    return run();
  } : undefined);
}
