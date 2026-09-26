#!/usr/bin/env node
/**
 * ---
 * purpose: Parse Shelf arguments, dispatch to a command handler, and print the result for people or agents.
 * related:
 *   - ./commands.ts - Command handlers keyed by contract name, each with its text renderer.
 * ---
 */
import { parseArgs } from 'node:util';
import { contract } from './contract.ts';
import { renderVersion } from './output.ts';
import { commandOptions, resolveCommand } from './commands.ts';

const outputFormats = ['auto', 'json', 'text'] as const;
const maxLimit = 10000;
type Format = (typeof outputFormats)[number];

try {
  const { positionals, options, format, limit } = parseCli();
  if (options.version) print({ name: 'shelf', version: contract.version }, format, renderVersion);
  else {
    const { command, args } = resolveCommand(options.help ? ['help', ...positionals.slice(0, 1)] : positionals);
    print(await command.run({ args, options, limit }), format, command.text);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: { kind: 'invalid_request', message: error instanceof Error ? error.message : String(error) } })}\n`);
  process.exitCode = 1;
}

function parseCli() {
  const { positionals, values: options } = parseArgs({ allowPositionals: true, options: {
    ...commandOptions,
    limit: { type: 'string', default: '100' }, version: { type: 'boolean' },
    output: { type: 'string', short: 'o', default: 'auto' }, help: { type: 'boolean', short: 'h' },
  } });
  if (!outputFormats.includes(options.output as Format)) throw new Error('Output must be auto, json, or text.');
  const limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new Error(`--limit must be an integer from 1 to ${maxLimit}.`);
  return { positionals, options, format: options.output as Format, limit };
}

/** Piped output defaults to JSON so agents parse it; a terminal gets text. */
function print(result: unknown, format: Format, text: (result: unknown) => string): void {
  const json = format === 'json' || (format === 'auto' && !process.stdout.isTTY);
  process.stdout.write(`${json ? JSON.stringify(result) : text(result)}\n`);
}
