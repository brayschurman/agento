#!/usr/bin/env node

import process from 'node:process';
import { Command } from 'commander';
import { runHealthCommand } from '../commands/health.js';
import { runMapCommand } from '../commands/map.js';
import packageJson from '../../package.json' with { type: 'json' };

const program = new Command();
const runDefault = async (
  options: { format?: string; summary?: boolean; map?: boolean; output?: string },
): Promise<void> => {
  if (options.map) {
    await runMapCommand(process.cwd(), { output: options.output });
    return;
  }

  const format = options.format === 'json' ? 'json' : 'text';
  await runHealthCommand(process.cwd(), { format, summary: options.summary === true });
};

program
  .name('agento')
  .description('AI operability scoring for repositories')
  .version(packageJson.version, '-v, --version', 'Show version')
  .showHelpAfterError('(run `agento --help` for usage)')
  .option('--map', 'Generate an interactive HTML architecture map')
  .option('--output <file>', 'Output file for generated artifacts')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--summary', 'Show the full health report summary')
  .action(runDefault);

program
  .command('health')
  .description('Run repository health and AI operability analysis')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--summary', 'Show the full health report summary')
  .action(async (options: { format?: string; summary?: boolean }) => {
    const format = options.format === 'json' ? 'json' : 'text';
    await runHealthCommand(process.cwd(), { format, summary: options.summary === true });
  });

program
  .command('map')
  .description('Generate an interactive HTML architecture map')
  .option('--output <file>', 'Output file path relative to the repository root')
  .action(async (options: { output?: string }) => {
    await runMapCommand(process.cwd(), { output: options.output });
  });

await program.parseAsync(process.argv);
