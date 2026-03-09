import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { analyzeAiOperability } from './ai-operability.js';
import { loadPlanioConfig } from './config.js';
import { scanRepository } from './repo-scan.js';

import type { PlanioConfig, RuleSeverity } from '../types/config.js';
import type {
  HealthEvidenceGroup,
  HealthItem,
  HealthReport,
  PackageManifest,
  RepoContext,
} from '../types/health.js';

const TEST_FILE_PATTERNS = ['.test.', '.spec.', '__tests__/'];
const FRAMEWORK_PACKAGES: Record<string, string> = {
  react: 'React',
  vue: 'Vue',
  svelte: 'Svelte',
  next: 'Next.js',
  nuxt: 'Nuxt',
  '@angular/core': 'Angular',
  express: 'Express',
  vite: 'Vite',
};
const NEXT_ARCHITECTURE_DIRECTORIES = ['app', 'lib', 'components', 'actions', 'db'];
const ARCHITECTURE_DIRECTORIES = ['services', 'controllers', 'repositories', 'domain', 'api', ...NEXT_ARCHITECTURE_DIRECTORIES];
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
const DEPENDENCY_USAGE_IGNORE = new Set([
  'next',
  'typescript',
  '@types/node',
  '@types/react',
  '@types/react-dom',
  'eslint',
  'prettier',
  'tsx',
  'tailwindcss',
  'postcss',
  'autoprefixer',
  'server-only',
]);

const HEALTH_SECTION_TITLES = {
  architecturalLegibility: 'Architectural Legibility',
  codeDiscoverability: 'Code Discoverability',
  contextDensity: 'Context Density',
  blastRadius: 'Blast Radius',
  changeSafety: 'Change Safety',
  agentTaskability: 'Agent Taskability',
  documentationSurface: 'Documentation Surface',
} as const;

export async function analyzeRepository(repoRoot: string): Promise<HealthReport> {
  const context = await scanRepository(repoRoot);
  const config = await loadPlanioConfig(repoRoot);
  const aiOperability = await analyzeAiOperability(context, config);

  return {
    repoRoot,
    projectLabel: buildProjectLabel(context.packageManifest),
    sections: [
      {
        title: HEALTH_SECTION_TITLES.architecturalLegibility,
        items: await buildArchitectureItems(context, config),
      },
      {
        title: HEALTH_SECTION_TITLES.codeDiscoverability,
        items: buildCodeDiscoverabilityItems(context, config),
      },
      {
        title: HEALTH_SECTION_TITLES.contextDensity,
        items: await buildContextDensityItems(context, config, aiOperability),
      },
      {
        title: HEALTH_SECTION_TITLES.blastRadius,
        items: await buildBlastRadiusItems(context, aiOperability),
        summary: context.markers.packageManager
          ? `Package manager: ${context.markers.packageManager}`
          : 'Package manager not detected',
      },
      {
        title: HEALTH_SECTION_TITLES.changeSafety,
        items: await buildChangeSafetyItems(context),
      },
      {
        title: HEALTH_SECTION_TITLES.agentTaskability,
        items: buildAgentTaskabilityItems(context, config),
      },
      {
        title: HEALTH_SECTION_TITLES.documentationSurface,
        items: buildDocumentationItems(context, config),
      },
    ],
    aiOperability,
  };
}

function buildCodeDiscoverabilityItems(context: RepoContext, config: PlanioConfig): HealthItem[] {
  const sourceDirectories = context.directories.filter((directory) =>
    ['src', 'app', 'packages', 'server', 'client'].includes(directory),
  );
  const genericFiles = context.files.filter((file) => GENERIC_FILENAMES.has(path.basename(file)));
  const genericNameSeverity = config.rules.files.genericNames;

  return [
    sourceDirectories.length > 0
      ? pass(
        `Clear source structure detected (${sourceDirectories.join(', ')})`,
        buildEvidenceGroup('Detected source roots', sourceDirectories.map((directory) => `${directory}/`)),
      )
      : warn(
        'No obvious source directory structure detected',
        'Create a primary source directory such as `src/`, `app/`, or `packages/` so code location is easier to infer.',
        54,
      ),
    buildSeverityItem(
      genericFiles.length === 0,
      'No generic module filenames detected',
      `Generic module filenames detected: ${genericFiles.slice(0, 3).join(', ')}`,
      'Rename generic files so the filename reflects the domain or responsibility.',
      genericNameSeverity,
      60,
    ),
  ].filter((item): item is HealthItem => item !== null);
}

async function buildContextDensityItems(
  context: RepoContext,
  config: PlanioConfig,
  aiOperability: HealthReport['aiOperability'],
): Promise<HealthItem[]> {
  const lineLimit = Math.max(1, config.rules.files.maxLines);
  const largeFiles = aiOperability.details.largeFilePaths;
  const severity = config.rules.comments.exportedFunctions;
  const undocumentedExports = await collectUndocumentedExportedFunctions(context);
  const commentItems =
    severity === 'off'
      ? [pass('Exported function comments are not required by config')]
      : [
        buildSeverityItem(
          undocumentedExports.length === 0,
          'Exported functions have leading comments',
          `Exported functions missing comments: ${undocumentedExports.slice(0, 3).join(', ')}`,
          'Add a short comment or JSDoc block above exported functions that define behavior or workflow boundaries.',
          severity,
          58,
        ),
      ].filter((item): item is HealthItem => item !== null);

  return [
    largeFiles.length === 0
      ? pass(`No files exceed ${lineLimit} lines`)
      : warn(
        `${largeFiles.length} files exceed ${lineLimit} lines`,
        `Split large files like ${largeFiles.slice(0, 2).join(', ')} into smaller modules so each task needs less local context.`,
        68,
      ),
    ...commentItems,
  ];
}

async function buildArchitectureItems(context: RepoContext, config: PlanioConfig): Promise<HealthItem[]> {
  const items: HealthItem[] = [];
  const sourceDirectories = context.directories.filter((directory) =>
    ['src', 'app', 'packages', 'server', 'client'].includes(directory),
  );
  const architectureBoundaries = ARCHITECTURE_DIRECTORIES.filter((directory) => hasDirectorySignal(context, directory));
  const requiredDirectories = config.rules.architecture.requiredDirs.filter((directory) => hasDirectorySignal(context, directory));
  const missingRequiredDirectories = config.rules.architecture.requiredDirs.filter((directory) => !hasDirectorySignal(context, directory));
  const bannedImportViolations = await collectBannedImportViolations(context, config);
  const componentFiles = context.files.filter((file) => /components\/.+\.(tsx|jsx)$/.test(file));
  const businessLogicComponents = await collectBusinessLogicComponentSignals(context, componentFiles);

  items.push(
    sourceDirectories.length > 0
      ? pass(
        `Clear source structure detected (${sourceDirectories.join(', ')})`,
        buildEvidenceGroup('Detected source roots', sourceDirectories.map((directory) => `${directory}/`)),
      )
      : warn(
        'No obvious source directory structure detected',
        'Create a primary source directory such as `src/`, `app/`, or `packages/`.',
        40,
      ),
  );

  items.push(
    architectureBoundaries.length > 0
      ? pass(
        `Architecture boundaries present (${architectureBoundaries.join(', ')})`,
        buildEvidenceGroup('Detected boundary directories', architectureBoundaries.map((directory) => `${directory}/`)),
      )
      : warn(
        'Service/domain boundary directories not found',
        'Introduce directories like `lib/`, `services/`, `db/`, or `domain/` to separate concerns.',
        58,
      ),
  );

  if (config.rules.architecture.requiredDirs.length > 0) {
    items.push(
      missingRequiredDirectories.length === 0
        ? pass(
          `Configured architecture directories present (${requiredDirectories.join(', ')})`,
          buildEvidenceGroup('Configured directories found', requiredDirectories.map((directory) => `${directory}/`)),
        )
        : fail(
          `Missing configured architecture directories: ${missingRequiredDirectories.join(', ')}`,
          'Create the required directories or update `agento.json` to match the repo architecture.',
          78,
          buildEvidenceGroup('Missing directories', missingRequiredDirectories.map((directory) => `${directory}/`)),
        ),
    );
  }

  items.push(
    businessLogicComponents.length > 0
      ? warn(
        'Business logic may be mixed into UI/component layer',
        'Move data fetching and orchestration into server actions, hooks, or service modules.',
        62,
        buildEvidenceGroup('Suspect component files', businessLogicComponents),
      )
      : pass('No obvious component/business-logic mixing signals detected'),
  );

  if (config.rules.architecture.bannedImports.length > 0) {
    items.push(
      bannedImportViolations.length === 0
        ? pass('No banned import boundary violations detected')
        : fail(
          `Banned import boundary violations: ${bannedImportViolations.slice(0, 3).join(', ')}`,
          'Move imports behind an allowed boundary or update `agento.json` if the rule is outdated.',
          82,
          buildEvidenceGroup('Violations', bannedImportViolations),
        ),
    );
  }

  return items;
}

async function buildBlastRadiusItems(
  context: RepoContext,
  aiOperability: HealthReport['aiOperability'],
): Promise<HealthItem[]> {
  const manifest = context.packageManifest;

  if (!manifest) {
    return [fail('No package.json detected for dependency analysis')];
  }

  const allDependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  const unusedDependencies = await detectUnusedDependencies(context, manifest);
  const highCouplingFiles = aiOperability.details.highCouplingFiles;

  return [
    allDependencies.length <= 50
      ? pass(`${allDependencies.length} declared dependencies`)
      : warn(
        `${allDependencies.length} declared dependencies`,
        'Review package overlap and remove low-value dependencies before the graph gets harder to manage.',
        45,
      ),
    unusedDependencies.length > 0
      ? warn(
        `Possibly unused dependencies: ${unusedDependencies.slice(0, 5).join(', ')}`,
        'Verify each package is needed for runtime, build, or configuration; remove the ones that are not.',
        52,
      )
      : pass('No obviously unused dependencies detected'),
    highCouplingFiles.length > 0
      ? warn(
        `High-coupling modules detected: ${highCouplingFiles.slice(0, 3).join(', ')}`,
        'Break orchestration-heavy modules into smaller collaborators so changes stay localized.',
        68,
        buildEvidenceGroup('Import-heavy files', highCouplingFiles.slice(0, 5)),
      )
      : pass('No import-heavy coupling hotspots detected'),
    warn(
      'Outdated dependency checks are not available offline in the MVP',
      'Add an online package audit in a later release or run your package manager update checks separately.',
      20,
    ),
  ];
}

async function buildChangeSafetyItems(context: RepoContext): Promise<HealthItem[]> {
  return [
    ...buildTestingItems(context),
    ...await buildTypeSafetyItems(context),
  ];
}

function buildTestingItems(context: RepoContext): HealthItem[] {
  const manifest = context.packageManifest;
  const dependencies = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
  ]);
  const testFrameworks = ['vitest', 'jest', '@playwright/test', 'cypress', 'mocha'].filter((item) =>
    dependencies.has(item),
  );
  const testDirectories = context.directories.filter((directory) => /^(test|tests|__tests__|e2e|spec)$/.test(directory));
  const testFiles = context.files.filter((file) => TEST_FILE_PATTERNS.some((pattern) => file.includes(pattern)));

  return [
    testFrameworks.length > 0
      ? pass(`Testing framework detected (${testFrameworks.join(', ')})`)
      : fail(
        'No test framework detected',
        'Add Vitest or Jest and cover at least the core flows and critical utilities.',
        95,
      ),
    testDirectories.length > 0
      ? pass(`Test directories present (${testDirectories.join(', ')})`)
      : warn(
        'No dedicated test directories found',
        'Add `tests/`, `__tests__/`, or colocated `*.test.ts` files so coverage is easy to locate.',
        50,
      ),
    testFiles.length > 0
      ? pass(`${testFiles.length} test files detected`)
      : warn(
        'No test files detected',
        'Start with smoke tests for the highest-risk user flows before broadening coverage.',
        75,
      ),
  ];
}

async function buildTypeSafetyItems(context: RepoContext): Promise<HealthItem[]> {
  const hasTypeScript = context.files.some((file) => /\.(ts|tsx)$/.test(file)) || context.files.includes('tsconfig.json');
  const tsConfigPath = path.join(context.repoRoot, 'tsconfig.json');
  const rawTsConfig = await safeRead(tsConfigPath);
  const strictEnabled = rawTsConfig ? /"strict"\s*:\s*true/.test(rawTsConfig) : false;

  return [
    hasTypeScript ? pass('TypeScript detected') : warn('TypeScript not detected'),
    rawTsConfig
      ? strictEnabled
        ? pass('Strict mode enabled')
        : warn('Strict mode disabled', 'Enable `strict: true` in `tsconfig.json` to tighten feedback loops.', 65)
      : warn('No tsconfig.json found', 'Add a `tsconfig.json` to make type-checking behavior explicit.', 55),
  ];
}

function buildDocumentationItems(context: RepoContext, config: PlanioConfig): HealthItem[] {
  const architectureDocSeverity: RuleSeverity = config.rules.docs.requireArchitectureDoc ? 'warn' : 'off';

  return [
    context.markers.hasReadme
      ? pass('README.md present')
      : config.rules.docs.requireReadme
        ? fail('README.md missing', 'Add a README with setup, commands, and a short architecture summary.', 90)
        : pass('README.md not required by config'),
    buildSeverityItem(
      context.markers.hasArchitectureDoc,
      'Architecture documentation present',
      'No architecture documentation detected',
      'Add `docs/architecture.md` with layers, ownership boundaries, and major flows.',
      architectureDocSeverity,
      72,
    ),
    context.markers.hasDocsDirectory
      ? pass('docs/ directory present')
      : warn('No docs/ directory detected', 'Add a `docs/` folder for architecture and contributor-facing notes.', 42),
    context.markers.hasContributingDoc
      ? pass('CONTRIBUTING.md present')
      : warn('CONTRIBUTING.md missing', 'Add a contributor guide with commands, review expectations, and local workflow notes.', 38),
  ].filter((item): item is HealthItem => item !== null);
}

function buildAgentTaskabilityItems(context: RepoContext, config: PlanioConfig): HealthItem[] {
  const manifest = context.packageManifest;
  const dependencies = new Set([
    ...Object.keys(manifest?.dependencies ?? {}),
    ...Object.keys(manifest?.devDependencies ?? {}),
  ]);
  const scripts = manifest?.scripts ?? {};
  const importantScripts = ['build', 'test', 'lint'].filter((scriptName) => scripts[scriptName]);

  const hasLinting =
    dependencies.has('eslint')
    || dependencies.has('@biomejs/biome')
    || Object.keys(scripts).includes('lint');
  const hasFormatting =
    dependencies.has('prettier')
    || dependencies.has('@biomejs/biome')
    || Object.keys(scripts).includes('format');
  const hasBuildTooling =
    dependencies.has('vite')
    || dependencies.has('tsup')
    || dependencies.has('webpack')
    || dependencies.has('rollup')
    || Object.keys(scripts).includes('build');

  return [
    context.markers.packageManager
      ? pass(`Package manager detected (${context.markers.packageManager})`)
      : warn('Package manager not detected', 'Declare a package manager so agents can infer the right install and task commands.', 42),
    importantScripts.length >= 2
      ? pass(`Core automation scripts detected (${importantScripts.join(', ')})`)
      : warn('Core automation scripts are sparse', 'Add explicit `build`, `test`, or `lint` scripts so agents have stable execution targets.', 52),
    hasLinting
      ? pass('Linting tooling detected')
      : warn('No linting tooling detected', 'Add ESLint or Biome so structural issues fail fast.', 48),
    hasFormatting
      ? pass('Formatting tooling detected')
      : warn('No formatting tooling detected', 'Add Prettier or Biome to keep diffs predictable.', 35),
    hasBuildTooling
      ? pass('Build tooling detected')
      : warn('No build tooling detected', 'Add an explicit build script even if the app is framework-managed.', 30),
    buildSeverityItem(
      context.markers.hasPlanioMd,
      'agento.md present',
      'agento.md missing',
      'Generate `agento.md` once `agento context --write` is available or create it manually for now.',
      config.rules.docs.requirePlanioMd ? 'warn' : 'off',
      60,
    ),
  ].filter((item): item is HealthItem => item !== null);
}

function buildProjectLabel(manifest: PackageManifest | null): string {
  if (!manifest) {
    return 'Unknown project';
  }

  const dependencies = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  const detectedFrameworks = Object.entries(FRAMEWORK_PACKAGES)
    .filter(([packageName]) => dependencies.has(packageName))
    .map(([, label]) => label);

  if (detectedFrameworks.length === 0) {
    return manifest.name ?? 'Node project';
  }

  return `${detectedFrameworks.join(' + ')} project`;
}

async function detectUnusedDependencies(
  context: RepoContext,
  manifest: PackageManifest,
): Promise<string[]> {
  const declaredDependencies = Object.keys(manifest.dependencies ?? {});
  const importedPackages = new Set<string>();
  const rawSourceMatches = new Map<string, boolean>();

  for (const file of context.files) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) {
      continue;
    }

    const contents = await safeRead(path.join(context.repoRoot, file));

    if (!contents) {
      continue;
    }

    for (const match of contents.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const rawImport = match[1] ?? match[2];

      if (!rawImport || rawImport.startsWith('.') || rawImport.startsWith('/')) {
        continue;
      }

      importedPackages.add(normalizePackageName(rawImport));
    }

    for (const dependency of declaredDependencies) {
      if (contents.includes(dependency)) {
        rawSourceMatches.set(dependency, true);
      }
    }
  }

  return declaredDependencies.filter((dependency) =>
    !importedPackages.has(dependency)
    && !rawSourceMatches.has(dependency)
    && !DEPENDENCY_USAGE_IGNORE.has(dependency),
  );
}

function normalizePackageName(rawImport: string): string {
  if (rawImport.startsWith('@')) {
    return rawImport.split('/').slice(0, 2).join('/');
  }

  return rawImport.split('/')[0] ?? rawImport;
}

async function collectFilesOverLineLimit(context: RepoContext, lineLimit: number): Promise<string[]> {
  const largeFiles: string[] = [];

  for (const file of context.files) {
    if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(file)) {
      continue;
    }

    const contents = await safeRead(path.join(context.repoRoot, file));

    if (!contents) {
      continue;
    }

    const lineCount = contents.split('\n').length;

    if (lineCount > lineLimit) {
      largeFiles.push(`${file} (${lineCount} lines)`);
    }
  }

  return largeFiles;
}

async function collectUndocumentedExportedFunctions(context: RepoContext): Promise<string[]> {
  const missingComments: string[] = [];

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

      const functionName = line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/)?.[1] ?? 'unknown';

      if (!hasLeadingComment(lines, index)) {
        missingComments.push(`${file}:${functionName}`);
      }
    }
  }

  return missingComments;
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

async function collectBannedImportViolations(
  context: RepoContext,
  config: PlanioConfig,
): Promise<string[]> {
  const violations: string[] = [];

  for (const file of context.files) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)) {
      continue;
    }

    const normalizedFile = normalizePath(file);
    const contents = await safeRead(path.join(context.repoRoot, file));

    if (!contents) {
      continue;
    }

    for (const rule of config.rules.architecture.bannedImports) {
      if (!isPathWithinBoundary(normalizedFile, rule.from)) {
        continue;
      }

      const imports = extractImportTargets(contents);

      for (const importTarget of imports) {
        const resolvedTarget = resolveImportTarget(file, importTarget);

        if (resolvedTarget && isPathWithinBoundary(resolvedTarget, rule.to)) {
          violations.push(`${file} -> ${rule.to} (${importTarget})`);
        }
      }
    }
  }

  return violations;
}

function extractImportTargets(contents: string): string[] {
  const matches = contents.matchAll(/from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g);
  const targets = new Set<string>();

  for (const match of matches) {
    const target = match[1] ?? match[2] ?? match[3];

    if (target) {
      targets.add(target);
    }
  }

  return [...targets];
}

function resolveImportTarget(fromFile: string, importTarget: string): string | null {
  if (importTarget.startsWith('.')) {
    const resolved = normalizePath(path.join(path.dirname(fromFile), importTarget));
    return resolved;
  }

  if (importTarget.startsWith('/')) {
    return normalizePath(importTarget.slice(1));
  }

  if (importTarget.startsWith('@')) {
    const withoutScope = importTarget.split('/').slice(1).join('/');
    return withoutScope ? normalizePath(withoutScope) : null;
  }

  if (importTarget.includes('/')) {
    return normalizePath(importTarget);
  }

  return null;
}

function isPathWithinBoundary(targetPath: string, boundary: string): boolean {
  const normalizedBoundary = normalizePath(boundary).replace(/\/$/, '');

  return targetPath === normalizedBoundary || targetPath.startsWith(`${normalizedBoundary}/`);
}

function normalizePath(targetPath: string): string {
  return targetPath.replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/^\.\//, '');
}

async function collectBusinessLogicComponentSignals(
  context: RepoContext,
  componentFiles: string[],
): Promise<string[]> {
  const signals: string[] = [];

  for (const file of componentFiles) {
    const contents = await safeRead(path.join(context.repoRoot, file));

    if (!contents) {
      continue;
    }

    const reasons: string[] = [];
    const importTargets = extractImportTargets(contents);
    const architectureImports = importTargets.filter((target) => /service|api|repository|usecase|actions?|db|domain/i.test(target));

    if (architectureImports.length > 0) {
      reasons.push(`imports ${architectureImports.slice(0, 2).join(', ')}`);
    }

    if (/\bfetch\s*\(/.test(contents)) {
      reasons.push('calls fetch()');
    }

    if (/\baxios\./.test(contents) || /\baxios\s*\(/.test(contents)) {
      reasons.push('calls axios');
    }

    if (/\buseMutation\b|\buseQuery\b/.test(contents)) {
      reasons.push('runs data hooks');
    }

    if (/\basync function\b|\bconst\s+\w+\s*=\s*async\s*\(/.test(contents)) {
      reasons.push('contains async workflow');
    }

    if (reasons.length > 0) {
      signals.push(`${file} (${reasons.join('; ')})`);
    }
  }

  return signals;
}

function buildEvidenceGroup(label: string, entries: string[]): HealthEvidenceGroup[] | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  return [
    {
      label,
      entries: entries.slice(0, 12),
    },
  ];
}

function buildSeverityItem(
  condition: boolean,
  passMessage: string,
  failMessage: string,
  remediation: string,
  severity: RuleSeverity,
  priority: number,
): HealthItem | null {
  if (condition) {
    return pass(passMessage);
  }

  if (severity === 'off') {
    return null;
  }

  return severity === 'error'
    ? fail(failMessage, remediation, priority)
    : warn(failMessage, remediation, priority);
}

function hasDirectorySignal(context: RepoContext, directory: string): boolean {
  if (context.directories.includes(directory)) {
    return true;
  }

  return context.files.some((file) => file.includes(`/${directory}/`) || file.startsWith(`${directory}/`));
}

function pass(message: string, evidence?: HealthEvidenceGroup[]): HealthItem {
  return { status: 'pass', message, priority: 0, evidence };
}

function warn(message: string, remediation?: string, priority = 50, evidence?: HealthEvidenceGroup[]): HealthItem {
  return { status: 'warn', message, remediation, priority, evidence };
}

function fail(message: string, remediation?: string, priority = 80, evidence?: HealthEvidenceGroup[]): HealthItem {
  return { status: 'fail', message, remediation, priority, evidence };
}

async function safeRead(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf8');
  } catch {
    return null;
  }
}
