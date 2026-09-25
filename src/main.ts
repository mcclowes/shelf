#!/usr/bin/env node
/**
 * ---
 * purpose: Parse Atlas arguments, dispatch to a command handler, and print the result for people or agents.
 * related:
 *   - ./commands.ts - Command handlers keyed by contract name.
 * ---
 */
import { parseArgs } from 'node:util';
import { contract } from './contract.ts';
import { renderText, renderVersion } from './output.ts';
import { resolveCommand, type Options } from './commands.ts';

const outputFormats = ['auto', 'json', 'text'] as const;
const maxLimit = 10000;
type Format = (typeof outputFormats)[number];

try {
  const { positionals, options, format, limit } = parseCli();
  if (options.version) print({ name: 'atlas', version: contract.version }, format, renderVersion);
  else {
    const { command, args } = resolveCommand(options.help ? ['help'] : positionals);
    print(await command.run({ args, options: options as Options, limit }), format);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { kind: 'invalid_request', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
}

function parseCli() {
  const { positionals, values: options } = parseArgs({ allowPositionals: true, options: {
    root: { type: 'string', multiple: true }, github: { type: 'string', multiple: true }, 'no-github': { type: 'boolean' },
    depth: { type: 'string' }, undescribed: { type: 'boolean' }, clear: { type: 'boolean' }, 'skills-dir': { type: 'string' },
    limit: { type: 'string', default: '100' }, version: { type: 'boolean' },
    output: { type: 'string', short: 'o', default: 'auto' }, help: { type: 'boolean', short: 'h' },
  } });
  if (!outputFormats.includes(options.output as Format)) throw new Error('Output must be auto, json, or text.');
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new Error(`--limit must be an integer from 1 to ${maxLimit}.`);
  return { positionals, options, format: options.output as Format, limit };
}

/** Piped output defaults to JSON so agents parse it; a terminal gets text. */
function print(result: unknown, format: Format, text: (result: unknown) => string = renderText): void {
  const json = format === 'json' || (format === 'auto' && !process.stdout.isTTY);
  process.stdout.write(`${json ? JSON.stringify(result) : text(result)}\n`);
}
