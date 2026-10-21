/**
 * ---
 * purpose: Serialize Shelf state changes across CLI processes, recovering locks left by exited processes.
 * ---
 */
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { shelfHome } from './store.ts';

const waitLimitMs = 65_000;

function removeOwnedLock(path: string, owner: Stats) {
  const current = lstatSync(path, { throwIfNoEntry: false });
  if (current?.ino === owner.ino && current.dev === owner.dev) unlinkSync(path);
}

function recoverLock(path: string): boolean {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return true;
  if (!entry.isFile() || entry.size > 128) throw new Error(`Invalid Shelf lock at ${path}.`);
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!text) {
    if (Date.now() - entry.mtimeMs < waitLimitMs) return false;
    removeOwnedLock(path, entry);
    return true;
  }
  const pid = Number(text.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Shelf lock at ${path}.`);
  try { process.kill(pid, 0); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    removeOwnedLock(path, entry);
    return true;
  }
  return false;
}

export async function withStateLock<T>(run: () => T, busy?: (error?: unknown) => T): Promise<T> {
  const home = shelfHome();
  const existed = existsSync(home);
  try { mkdirSync(home, { recursive: true }); } catch (error) {
    if (busy) return busy(error);
    throw error;
  }
  const path = join(home, '.lock');
  const deadline = Date.now() + waitLimitMs;
  let owner: Stats | undefined;
  try {
    while (!owner) {
      let file: number;
      try { file = openSync(path, 'wx', 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (busy) return busy(error);
          throw error;
        }
        try { if (recoverLock(path)) continue; } catch (error) {
          if (busy) return busy(error);
          throw error;
        }
        if (busy) return busy();
        if (Date.now() >= deadline) throw new Error('Another Shelf command is still updating state. Retry shortly.');
        await setTimeout(50);
        continue;
      }
      try {
        owner = fstatSync(file);
        writeFileSync(file, `${process.pid}\n`);
      } finally { closeSync(file); }
    }
    return run();
  } finally {
    if (owner) removeOwnedLock(path, owner);
    if (!existed) {
      try { rmdirSync(home); } catch { /* Keep state created by the command. */ }
    }
  }
}
