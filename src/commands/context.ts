import chalk from 'chalk';
import { buildContextArtifact, generateContextArtifact } from '../core/context.js';
import { detectRepositoryRoot } from '../core/repo-scan.js';

export interface RunContextCommandOptions {
  stdout?: boolean;
  write?: boolean;
}

export async function runContextCommand(
  startDirectory: string,
  options: RunContextCommandOptions = {},
): Promise<void> {
  if (!options.write && !options.stdout) {
    console.error(chalk.red('Context generation requires `--write` or `--stdout`.'));
    process.exitCode = 1;
    return;
  }

  const repoRoot = await detectRepositoryRoot(startDirectory);

  if (!repoRoot) {
    console.error(chalk.red('No repository root detected from the current directory.'));
    process.exitCode = 1;
    return;
  }

  if (options.stdout) {
    const artifact = await buildContextArtifact(repoRoot);
    console.log(artifact.markdown);

    if (!options.write) {
      return;
    }
  }

  const artifact = await generateContextArtifact(repoRoot);

  console.log(chalk.green('Created agento.md'));
  console.log(`Location: ${artifact.outputPath}`);
  console.log('');
  console.log('Next step: review the generated context, then paste it into Codex or Claude as needed.');
}
