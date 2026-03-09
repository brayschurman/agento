import chalk from 'chalk';
import {
  APP_CONFIG_FILENAME,
  planioConfigExists,
  writePlanioConfig,
} from '../core/config.js';
import { detectRepositoryRoot } from '../core/repo-scan.js';

export interface RunInitCommandOptions {
  force?: boolean;
}

export async function runInitCommand(
  startDirectory: string,
  options: RunInitCommandOptions = {},
): Promise<void> {
  const repoRoot = await detectRepositoryRoot(startDirectory);
  const targetDirectory = repoRoot ?? startDirectory;
  const targetLabel = repoRoot ? 'repository root' : 'current directory';

  if (await planioConfigExists(targetDirectory)) {
    if (!options.force) {
      console.error(
        chalk.red(
          `${APP_CONFIG_FILENAME} already exists in the ${targetLabel}. Re-run with --force to overwrite it.`,
        ),
      );
      process.exitCode = 1;
      return;
    }
  }

  const configPath = await writePlanioConfig(targetDirectory);

  console.log(chalk.green(`Created ${APP_CONFIG_FILENAME}`));
  console.log(`Location: ${configPath}`);
  console.log('');
  console.log('Next step: review the defaults, then run `agento health`.');
}
