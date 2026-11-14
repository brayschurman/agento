import chalk from 'chalk';
import { generateArchitectureMapArtifact } from '../core/architecture-map.js';
import { detectRepositoryRoot } from '../core/repo-scan.js';

export interface RunMapCommandOptions {
  output?: string;
}

export async function runMapCommand(
  startDirectory: string,
  options: RunMapCommandOptions = {},
): Promise<void> {
  const repoRoot = await detectRepositoryRoot(startDirectory);

  if (!repoRoot) {
    console.error(chalk.red('No repository root detected from the current directory.'));
    process.exitCode = 1;
    return;
  }

  const artifact = await generateArchitectureMapArtifact(repoRoot, { outputFile: options.output });

  console.log(chalk.green('Created interactive architecture map'));
  console.log(`Location: ${artifact.outputPath}`);
  console.log('');
  console.log('Next step: open the HTML file in a browser and explore modules, layers, and import paths.');
}
