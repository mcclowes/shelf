import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const staging = mkdtempSync(join(tmpdir(), 'shelf-release-'));
let outputStaging = '';
let retainOutputStaging = false;
try {
  const directory = join(staging, `shelf-${version}`);
  mkdirSync(directory);
  cpSync(new URL('dist/', root), join(directory, 'dist'), { recursive: true });
  for (const file of ['package.json', 'LICENSE', 'README.md']) cpSync(new URL(file, root), join(directory, file));
  mkdirSync(new URL('release/', root), { recursive: true });
  const archive = resolve(`release/shelf-${version}.tar.gz`);
  outputStaging = mkdtempSync(join(dirname(archive), '.shelf-release-output-'));
  const stagedArchive = join(outputStaging, basename(archive));
  execFileSync('tar', ['-czf', stagedArchive, '-C', staging, `shelf-${version}`]);
  const digest = createHash('sha256').update(readFileSync(stagedArchive)).digest('hex');
  writeFileSync(`${stagedArchive}.sha256`, `${digest}  shelf-${version}.tar.gz\n`);
  const previousArchive = join(outputStaging, 'previous-archive.tar.gz');
  const hadPreviousArchive = existsSync(archive);
  if (hadPreviousArchive) cpSync(archive, previousArchive);
  renameSync(stagedArchive, archive);
  try {
    renameSync(`${stagedArchive}.sha256`, `${archive}.sha256`);
  } catch (promotionError) {
    try {
      if (hadPreviousArchive) renameSync(previousArchive, archive);
      else rmSync(archive);
    } catch (rollbackError) {
      retainOutputStaging = true;
      throw new AggregateError(
        [promotionError, rollbackError],
        `Could not restore release archive; recovery files retained in ${outputStaging}`,
      );
    }
    throw promotionError;
  }
  console.log(`${archive}\n${digest}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
  if (outputStaging && !retainOutputStaging) rmSync(outputStaging, { recursive: true, force: true });
}
