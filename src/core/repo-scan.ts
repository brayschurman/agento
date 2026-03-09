import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type {
  PackageManifest,
  RepoContext,
  RepoMarkers,
} from '../types/health.js';

const DEFAULT_SCAN_IGNORES = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/storybook-static/**',
  '!**/.next/**',
  '!**/.turbo/**',
];

const REPO_MARKERS = [
  '.git',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
];

const LOCKFILE_NAMES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'Pipfile.lock',
  'poetry.lock',
]);

export async function detectRepositoryRoot(startDirectory: string): Promise<string | null> {
  let currentDirectory = path.resolve(startDirectory);

  while (true) {
    if (await hasRepositoryMarker(currentDirectory)) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (parentDirectory === currentDirectory) {
      return null;
    }

    currentDirectory = parentDirectory;
  }
}

export async function scanRepository(repoRoot: string): Promise<RepoContext> {
  const markers = await collectRepoMarkers(repoRoot);
  const packageManifest = await readPackageManifest(repoRoot);
  const directories = await listTopLevelDirectories(repoRoot);

  const files = await fg(['**/*', ...DEFAULT_SCAN_IGNORES], {
    cwd: repoRoot,
    dot: true,
    onlyFiles: true,
    suppressErrors: true,
  });
  const filteredFiles = await filterIgnoredFiles(repoRoot, files);

  return {
    repoRoot,
    markers,
    packageManifest,
    directories,
    files: filteredFiles,
  };
}

async function hasRepositoryMarker(directory: string): Promise<boolean> {
  for (const marker of REPO_MARKERS) {
    try {
      await access(path.join(directory, marker));
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

async function collectRepoMarkers(repoRoot: string): Promise<RepoMarkers> {
  const checks = await Promise.all(
    REPO_MARKERS.map(async (marker) => ({
      marker,
      exists: await pathExists(path.join(repoRoot, marker)),
    })),
  );

  const presentMarkers = new Set(checks.filter((entry) => entry.exists).map((entry) => entry.marker));

  return {
    hasGit: presentMarkers.has('.git'),
    packageManager: presentMarkers.has('pnpm-lock.yaml')
      ? 'pnpm'
      : presentMarkers.has('yarn.lock')
        ? 'yarn'
        : presentMarkers.has('package-lock.json')
          ? 'npm'
          : presentMarkers.has('bun.lock') || presentMarkers.has('bun.lockb')
            ? 'bun'
            : null,
    hasReadme:
      (await pathExists(path.join(repoRoot, 'README.md')))
      || (await pathExists(path.join(repoRoot, 'readme.md'))),
    hasDocsDirectory: await pathExists(path.join(repoRoot, 'docs')),
    hasArchitectureDoc:
      (await pathExists(path.join(repoRoot, 'architecture.md')))
      || (await pathExists(path.join(repoRoot, 'ARCHITECTURE.md'))),
    hasContributingDoc:
      (await pathExists(path.join(repoRoot, 'CONTRIBUTING.md')))
      || (await pathExists(path.join(repoRoot, '.github', 'CONTRIBUTING.md'))),
    hasPlanioMd:
      (await pathExists(path.join(repoRoot, 'agento.md')))
      || (await pathExists(path.join(repoRoot, 'AGENTO.md')))
      || (await pathExists(path.join(repoRoot, 'planio.md')))
      || (await pathExists(path.join(repoRoot, 'PLANIO.md'))),
  };
}

async function readPackageManifest(repoRoot: string): Promise<PackageManifest | null> {
  const manifestPath = path.join(repoRoot, 'package.json');

  if (!(await pathExists(manifestPath))) {
    return null;
  }

  try {
    const rawManifest = await readFile(manifestPath, 'utf8');
    return JSON.parse(rawManifest) as PackageManifest;
  } catch {
    return null;
  }
}

async function listTopLevelDirectories(repoRoot: string): Promise<string[]> {
  const entries = await readdir(repoRoot, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git')
    .map((entry) => entry.name)
    .sort();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function filterIgnoredFiles(repoRoot: string, files: string[]): Promise<string[]> {
  const results = await Promise.all(
    files.map(async (file) => ({
      file,
      ignore: await shouldIgnoreRepoFile(repoRoot, file),
    })),
  );

  return results
    .filter((entry) => !entry.ignore)
    .map((entry) => entry.file)
    .sort();
}

async function shouldIgnoreRepoFile(repoRoot: string, file: string): Promise<boolean> {
  const normalizedFile = file.replace(/\\/g, '/');
  const baseName = path.basename(normalizedFile);

  if (LOCKFILE_NAMES.has(baseName)) {
    return true;
  }

  if (
    /(^|\/)(generated|__generated__|compiled|artifacts)\//i.test(normalizedFile)
    || /\.generated\.[^/]+$/i.test(baseName)
    || /\.(min\.(js|css)|map)$/i.test(baseName)
    || /\.(tgz|tar\.gz|zip)$/i.test(baseName)
  ) {
    return true;
  }

  if (isLikelyCompiledAsset(normalizedFile)) {
    return true;
  }

  if (isLikelyVendoredPublicModule(normalizedFile)) {
    const fileSize = await getFileSize(path.join(repoRoot, normalizedFile));

    return fileSize === null || fileSize >= 150_000 || /(?:^|[-.])(worker|vendor|bundle|chunk|pdf)(?:[-.]|$)/i.test(baseName);
  }

  return false;
}

function isLikelyCompiledAsset(file: string): boolean {
  return /(^|\/)(public|static|assets)\//i.test(file)
    && (
      /\.[A-Z0-9_-]{8,}\.(js|css)$/i.test(path.basename(file))
      || /(?:^|[-.])(bundle|chunk|vendor)(?:[-.]|$).*\.(js|css)$/i.test(path.basename(file))
    );
}

function isLikelyVendoredPublicModule(file: string): boolean {
  return /(^|\/)public\/.+\.mjs$/i.test(file);
}

async function getFileSize(targetPath: string): Promise<number | null> {
  try {
    const stats = await stat(targetPath);

    return stats.size;
  } catch {
    return null;
  }
}
