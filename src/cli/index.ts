#!/usr/bin/env node

import process from 'node:process';
import { Command } from 'commander';
import { runHealthCommand } from '../commands/health.js';
import packageJson from '../../package.json' with { type: 'json' };

const program = new Command();
const runHealth = async (options: { format?: string; summary?: boolean }): Promise<void> => {
  const format = options.format === 'json' ? 'json' : 'text';
  await runHealthCommand(process.cwd(), { format, summary: options.summary === true });
};

program
  .name('agento')
  .description('AI operability scoring for repositories')
  .version(packageJson.version, '-v, --version', 'Show version')
  .showHelpAfterError('(run `agento --help` for usage)')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--summary', 'Show the full health report summary')
  .action(runHealth);

program
  .command('health')
  .description('Run repository health and AI operability analysis')
  .option('--format <format>', 'Output format: text or json', 'text')
  .option('--summary', 'Show the full health report summary')
  .action(runHealth);

await program.parseAsync(process.argv);
