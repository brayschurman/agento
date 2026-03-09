import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlanioConfig } from '../types/config.js';
import type {
  AgentHostileArea,
  AiOperabilityReport,
  AiOperabilitySubscore,
  RepoContext,
} from '../types/health.js';

const GENERIC_FILENAMES = new Set([
  'utils.ts',
  'utils.js',
  'helpers.ts',
  'helpers.js',
  'misc.ts',
  'misc.js',
  'stuff.ts',
  'stuff.js',
]);

const ARCHITECTURE_DIRECTORIES = ['services', 'controllers', 'repositories', 'domain', 'api', 'lib', 'components', 'actions', 'db'];

export async function analyzeAiOperability(
  context: RepoContext,
  config: PlanioConfig,
): Promise<AiOperabilityReport> {
  const warnings: AiOperabilityReport['warnings'] = [];
  const largeFileLimit = Math.max(1, config.rules.files.maxLines);
  const architectureDirectories = new Set([
    ...ARCHITECTURE_DIRECTORIES,
    ...config.rules.architecture.requiredDirs,
  ]);

  const largeFileSignals = await collectLargeFileSignals(context, largeFileLimit);
  const genericFiles = context.files.filter((file) => GENERIC_FILENAMES.has(path.basename(file)));
  const architectureSignals = [...architectureDirectories].filter((directory) => hasDirectorySignal(context, directory));
  const importHeavyFiles = await collectImportHeavyFiles(context);
  const agentHostileAreas = buildAgentHostileAreas(
    largeFileSignals.largeFilePaths,
    largeFileSignals.hugeFilePaths,
    importHeavyFiles,
    genericFiles,
  );
  const dependencyCount = countDependencies(context);
  const testFileCount = countTestFiles(context);
  const hasTestFramework = hasTestingFramework(context);
  const strictEnabled = await hasStrictTypeScript(context);
  const taskability = evaluateAgentTaskability(context);
  const hasDocs = context.markers.hasDocsDirectory || context.markers.hasArchitectureDoc;
  const sourceRoots = context.directories.filter((directory) =>
    ['src', 'app', 'packages', 'server', 'client'].includes(directory),
  );
  const undocumentedExports = await countUndocumentedExportedFunctions(context);

  if (largeFileSignals.overLimit > 0) {
    warnings.push({
      status: 'warn',
      message: `${largeFileSignals.overLimit} files exceed ${largeFileLimit} lines`,
      remediation: `Split large files by feature or responsibility until files stay below ${largeFileLimit} lines.`,
      priority: largeFileSignals.over1000 > 0 ? 80 : 65,
    });
  }

  if (largeFileSignals.over1000 > 0) {
    warnings.push({
      status: 'warn',
      message: `${largeFileSignals.over1000} files exceed 1000 lines`,
      remediation: 'Break monolithic modules into smaller focused files before adding new behavior.',
      priority: 90,
    });
  }

  if (genericFiles.length > 0 && config.rules.files.genericNames !== 'off') {
    const status = config.rules.files.genericNames === 'error' ? 'fail' : 'warn';

    warnings.push({
      status,
      message: `Generic modules detected: ${genericFiles.slice(0, 3).join(', ')}`,
      remediation: 'Rename broad utility files to reflect the domain or behavior they actually own.',
      priority: 60,
    });
  }

  if (architectureSignals.length === 0) {
    warnings.push({
      status: 'warn',
      message: 'No explicit architecture boundary directories detected',
      remediation: 'Add directories like `lib/`, `services/`, `db/`, or `domain/` to separate responsibilities.',
      priority: 55,
    });
  }

  if (dependencyCount > 150) {
    warnings.push({
      status: 'warn',
      message: `Dependency graph is large (${dependencyCount} declared packages)`,
      remediation: 'Audit low-value packages and reduce framework overlap where possible.',
      priority: dependencyCount > 300 ? 75 : 50,
    });
  }

  if (!context.markers.hasReadme) {
    warnings.push({
      status: 'fail',
      message: 'README.md is missing',
      remediation: 'Add a README with setup, commands, and a short system overview.',
      priority: 85,
    });
  }

  if (!context.markers.hasDocsDirectory && !context.markers.hasArchitectureDoc) {
    warnings.push({
      status: 'warn',
      message: 'No docs/ directory or architecture document detected',
      remediation: 'Add `docs/architecture.md` describing app layers, data flow, and key modules.',
      priority: 70,
    });
  }

  if (importHeavyFiles.length > 0) {
    warnings.push({
      status: 'warn',
      message: `High-coupling candidates: ${importHeavyFiles.slice(0, 3).join(', ')}`,
      remediation: 'Reduce module fan-in by extracting orchestration logic into smaller collaborators.',
      priority: 68,
    });
  }

  const subscores: AiOperabilitySubscore[] = [
    {
      key: 'codeDiscoverability',
      label: 'Code Discoverability',
      score: clampScore(
        100
          - (sourceRoots.length > 0 ? 0 : 35)
          - Math.min(60, genericFiles.length * 20),
      ),
      weight: 0.14,
    },
    {
      key: 'contextDensity',
      label: 'Context Density',
      score: clampScore(
        100
          - Math.min(40, largeFileSignals.overLimit * 8)
          - Math.min(35, largeFileSignals.over1000 * 20)
          - Math.min(25, undocumentedExports * 6),
      ),
      weight: 0.16,
    },
    {
      key: 'architecturalLegibility',
      label: 'Architectural Legibility',
      score: clampScore(
        100
          - (architectureSignals.length === 0 ? 40 : 0)
          - Math.max(0, 20 - architectureSignals.length * 5)
          - Math.min(20, importHeavyFiles.length * 4),
      ),
      weight: 0.18,
    },
    {
      key: 'blastRadius',
      label: 'Blast Radius',
      score: clampScore(
        100
          - Math.min(35, importHeavyFiles.length * 8)
          - (dependencyCount > 300 ? 30 : dependencyCount > 150 ? 18 : dependencyCount > 50 ? 8 : 0),
      ),
      weight: 0.14,
    },
    {
      key: 'changeSafety',
      label: 'Change Safety',
      score: clampScore(
        100
          - (hasTestFramework ? 0 : 45)
          - (testFileCount > 0 ? 0 : 25)
          - (strictEnabled ? 0 : 18),
      ),
      weight: 0.16,
    },
    {
      key: 'agentTaskability',
      label: 'Agent Taskability',
      score: clampScore(
        100
          - (taskability.hasPackageManager ? 0 : 20)
          - (taskability.importantScriptCount >= 2 ? 0 : 24)
          - (taskability.hasLinting ? 0 : 16)
          - (taskability.hasFormatting ? 0 : 10)
          - (taskability.hasBuildTooling ? 0 : 10)
          - (context.markers.hasPlanioMd ? 0 : 20),
      ),
      weight: 0.12,
    },
    {
      key: 'documentationSurface',
      label: 'Documentation Surface',
      score: clampScore(
        100
          - (context.markers.hasReadme ? 0 : 50)
          - (hasDocs ? 0 : 35)
          - (context.markers.hasContributingDoc ? 0 : 10),
      ),
      weight: 0.1,
    },
  ];
  const score = Math.round(
    subscores.reduce((total, subscore) => total + subscore.score * subscore.weight, 0),
  );

  return {
    score,
    warnings,
    subscores,
    details: {
      largeFilesOverLimit: largeFileSignals.overLimit,
      largeFileLimit,
      largeFilesOver1000: largeFileSignals.over1000,
      largeFilePaths: largeFileSignals.largeFilePaths,
      hugeFilePaths: largeFileSignals.hugeFilePaths,
      genericFiles,
      genericFileCount: genericFiles.length,
      architectureSignalCount: architectureSignals.length,
      dependencyCount,
      highCouplingFiles: importHeavyFiles,
      agentHostileAreas,
    },
  };
}

async function hasStrictTypeScript(context: RepoContext): Promise<boolean> {
  const rawTsConfig = await safeRead(path.join(context.repoRoot, 'tsconfig.json'));

  return rawTsConfig ? /"strict"\s*:\s*true/.test(rawTsConfig) : false;
}

function evaluateAgentTaskability(context: RepoContext): {
  hasPackageManager: boolean;
  importantScriptCount: number;
  hasLinting: boolean;
  hasFormatting: boolean;
  hasBuildTooling: boolean;
} {
  const manifest = context.packageManifest;
  const dependencies = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
  ]);
  const scripts = manifest?.scripts ?? {};
  const importantScriptCount = ['build', 'test', 'lint'].filter((scriptName) => scripts[scriptName]).length;

  return {
    hasPackageManager: context.markers.packageManager !== null,
    importantScriptCount,
    hasLinting:
      dependencies.has('eslint')
      || dependencies.has('@biomejs/biome')
      || Object.keys(scripts).includes('lint'),
    hasFormatting:
      dependencies.has('prettier')
      || dependencies.has('@biomejs/biome')
      || Object.keys(scripts).includes('format'),
    hasBuildTooling:
      dependencies.has('vite')
      || dependencies.has('tsup')
      || dependencies.has('webpack')
      || dependencies.has('rollup')
      || Object.keys(scripts).includes('build'),
  };
}

async function countUndocumentedExportedFunctions(context: RepoContext): Promise<number> {
  let missingCount = 0;

  for (const file of context.files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
      continue;
    }

    const contents = await safeRead(path.join(context.repoRoot, file));

    if (!contents) {
      continue;
    }

    const lines = contents.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? '';

      if (!/^export\s+(async\s+)?function\s+[A-Za-z0-9_]+\s*\(/.test(line)) {
        continue;
      }

      if (!hasLeadingComment(lines, index)) {
        missingCount += 1;
      }
    }
  }

  return missingCount;
}

function hasLeadingComment(lines: string[], index: number): boolean {
  let cursor = index - 1;

  while (cursor >= 0) {
    const line = lines[cursor]?.trim() ?? '';

    if (line === '') {
      cursor -= 1;
      continue;
    }

    if (line.startsWith('//') || line.startsWith('/**') || line.startsWith('*') || line.endsWith('*/')) {
      return true;
    }

    return false;
  }

  return false;
}

async function collectLargeFileSignals(
  context: RepoContext,
  lineLimit: number,
) : Promise<{
  overLimit: number;
  over1000: number;
  largeFilePaths: string[];
  hugeFilePaths: string[];
}> {
  let overLimit = 0;
  let over1000 = 0;
  const largeFilePaths: string[] = [];
  const hugeFilePaths: string[] = [];

  for (const file of context.files) {
    if (!isCodeFile(file)) {
      continue;
    }

    const contents = await safeRead(path.join(context.repoRoot, file));

    if (contents === null) {
      continue;
    }

    const lineCount = contents.split('\n').length;

    if (lineCount > lineLimit) {
      overLimit += 1;
      largeFilePaths.push(`${file} (${lineCount} lines)`);
    }

    if (lineCount > 1000) {
      over1000 += 1;
      hugeFilePaths.push(`${file} (${lineCount} lines)`);
    }
  }

  return { overLimit, over1000, largeFilePaths, hugeFilePaths };
}

async function collectImportHeavyFiles(context: RepoContext): Promise<string[]> {
  const results: string[] = [];

  for (const file of context.files) {
    if (!isCodeFile(file)) {
      continue;
    }

    const contents = await safeRead(path.join(context.repoRoot, file));

    if (contents === null) {
      continue;
    }

    const importCount = contents.match(/^\s*import\s.+$/gm)?.length ?? 0;

    if (importCount >= 15) {
      results.push(`${file} (${importCount} imports)`);
    }
  }

  return results;
}

function countDependencies(context: RepoContext): number {
  const manifest = context.packageManifest;

  if (!manifest) {
    return 0;
  }

  return Object.keys(manifest.dependencies ?? {}).length + Object.keys(manifest.devDependencies ?? {}).length;
}

function countTestFiles(context: RepoContext): number {
  return context.files.filter((file) => file.includes('.test.') || file.includes('.spec.') || file.includes('__tests__/')).length;
}

function hasTestingFramework(context: RepoContext): boolean {
  const manifest = context.packageManifest;
  const dependencies = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
  ]);

  return ['vitest', 'jest', '@playwright/test', 'cypress', 'mocha'].some((item) => dependencies.has(item));
}

function isCodeFile(file: string): boolean {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(file) && !isGeneratedLikeFile(file);
}

function isGeneratedLikeFile(file: string): boolean {
  return /(^|\/)(generated|__generated__|dist|build|coverage|storybook-static)\//.test(file)
    || /\.generated\.[^/]+$/i.test(path.basename(file))
    || /\.(min\.(js|css)|map)$/i.test(path.basename(file))
    || /schema\.prisma$/.test(file);
}

function hasDirectorySignal(context: RepoContext, directory: string): boolean {
  if (context.directories.includes(directory)) {
    return true;
  }

  return context.files.some((file) => file.includes(`/${directory}/`) || file.startsWith(`${directory}/`));
}

async function safeRead(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf8');
  } catch {
    return null;
  }
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function buildAgentHostileAreas(
  largeFiles: string[],
  hugeFiles: string[],
  importHeavyFiles: string[],
  genericFiles: string[],
): AgentHostileArea[] {
  const candidates = new Map<string, AgentHostileArea>();

  for (const entry of importHeavyFiles) {
    const { filePath, count } = parseMetricEntry(entry, 'imports');
    const candidate = getOrCreateArea(candidates, filePath);
    const reason = count
      ? `${count} imports, likely orchestration hub, broad blast radius`
      : 'many imports, likely orchestration hub, broad blast radius';

    candidate.reasons.push(reason);
    candidate.score += (count ?? 15) * 2;

    if (isUiOrchestrationPath(filePath)) {
      candidate.score += 16;
    }
  }

  for (const entry of largeFiles) {
    const { filePath, count } = parseMetricEntry(entry, 'lines');
    const candidate = getOrCreateArea(candidates, filePath);
    const reason = describeLargeFileRisk(filePath, count);

    candidate.reasons.push(reason);
    candidate.score += Math.round((count ?? 500) / 12);

    if (hugeFiles.some((hugeFile) => hugeFile.startsWith(filePath))) {
      candidate.score += 20;
    }
  }

  for (const filePath of genericFiles) {
    const candidate = getOrCreateArea(candidates, filePath);
    candidate.reasons.push('generic filename hides intent, likely shared grab-bag module');
    candidate.score += 18;
  }

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      reasons: dedupe(candidate.reasons).slice(0, 2),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);
}

function getOrCreateArea(
  candidates: Map<string, AgentHostileArea>,
  filePath: string,
): AgentHostileArea {
  const existing = candidates.get(filePath);

  if (existing) {
    return existing;
  }

  const created: AgentHostileArea = {
    filePath,
    reasons: [],
    score: 0,
  };

  candidates.set(filePath, created);
  return created;
}

function parseMetricEntry(entry: string, unit: 'imports' | 'lines'): { filePath: string; count: number | null } {
  const pattern = unit === 'imports'
    ? /^(.*)\s+\((\d+)\s+imports\)$/
    : /^(.*)\s+\((\d+)\s+lines\)$/;
  const match = entry.match(pattern);

  if (!match) {
    return { filePath: entry, count: null };
  }

  return {
    filePath: match[1] ?? entry,
    count: Number.parseInt(match[2] ?? '', 10) || null,
  };
}

function describeLargeFileRisk(filePath: string, count: number | null): string {
  const sizeLabel = count ? `${count} lines` : 'very large file';
  const normalizedPath = filePath.toLowerCase();

  if (normalizedPath.includes('/component') || normalizedPath.includes('/components/')) {
    return `${sizeLabel}, large UI file with likely mixed state/render logic`;
  }

  if (
    normalizedPath.includes('form')
    || normalizedPath.includes('claim')
    || normalizedPath.includes('/domain/')
    || normalizedPath.includes('/service')
    || normalizedPath.includes('/services/')
  ) {
    return `${sizeLabel}, likely dense domain logic, difficult to patch confidently`;
  }

  if (normalizedPath.includes('root') || normalizedPath.includes('app') || normalizedPath.includes('layout')) {
    return `${sizeLabel}, likely central app shell, broad surface area`;
  }

  return `${sizeLabel}, broad surface area, difficult to patch confidently`;
}

function isUiOrchestrationPath(filePath: string): boolean {
  const normalizedPath = filePath.toLowerCase();

  return normalizedPath.includes('root')
    || normalizedPath.includes('layout')
    || normalizedPath.includes('navigation')
    || normalizedPath.includes('nav')
    || normalizedPath.includes('app');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
