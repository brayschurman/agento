import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { analyzeRepository } from './health-check.js';
import { scanRepository } from './repo-scan.js';

import type { HealthReport, RepoContext } from '../types/health.js';

const MAP_OUTPUT_FILENAME = 'agento-map.html';
const DEFAULT_DESKTOP_OUTPUT_PATH = path.join(homedir(), 'Desktop', MAP_OUTPUT_FILENAME);
const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SOURCE_ROOTS = new Set(['src', 'app', 'packages', 'server', 'client', 'lib', 'scripts']);

interface GenerateArchitectureMapOptions {
  outputFile?: string;
}

interface ArchitectureMapArtifact {
  html: string;
  outputPath: string;
}

interface FileMetric {
  path: string;
  label: string;
  lineCount: number;
  importCount: number;
  inboundCount: number;
  riskScore: number;
  riskLabel: string;
  warnings: string[];
  whyFlagged: string[];
  aiImpact: string[];
  recommendedActions: string[];
  safeTask: string;
}

interface TreeNode {
  id: string;
  name: string;
  path: string;
  kind: 'directory' | 'file';
  value: number;
  riskScore: number;
  riskLabel: string;
  warnings: string[];
  children?: TreeNode[];
  file?: FileMetric;
}

interface ArchitectureMapData {
  meta: {
    repoRoot: string;
    projectLabel: string;
    score: number;
    packageManager: string;
    totalFiles: number;
    totalLines: number;
    largestFiles: FileMetric[];
    hardestFiles: FileMetric[];
  };
  tree: TreeNode;
}

export async function generateArchitectureMapArtifact(
  repoRoot: string,
  options: GenerateArchitectureMapOptions = {},
): Promise<ArchitectureMapArtifact> {
  const [context, report] = await Promise.all([
    scanRepository(repoRoot),
    analyzeRepository(repoRoot),
  ]);
  const data = await buildArchitectureMapData(context, report);
  const html = renderArchitectureMapHtml(data);
  const outputPath = resolveOutputPath(repoRoot, options.outputFile);

  await writeFile(outputPath, `${html}\n`, 'utf8');

  return { html, outputPath };
}

function resolveOutputPath(repoRoot: string, outputFile?: string): string {
  if (!outputFile) {
    return DEFAULT_DESKTOP_OUTPUT_PATH;
  }

  if (path.isAbsolute(outputFile)) {
    return outputFile;
  }

  return path.join(repoRoot, outputFile);
}

async function buildArchitectureMapData(
  context: RepoContext,
  report: HealthReport,
): Promise<ArchitectureMapData> {
  const codeFiles = context.files.filter((file) => {
    if (!CODE_FILE_PATTERN.test(file)) {
      return false;
    }

    const root = file.split('/')[0] ?? '';

    return SOURCE_ROOTS.has(root);
  });

  const largeFiles = parseMetricEntries(report.aiOperability.details.largeFilePaths, 'lines');
  const highCouplingFiles = parseMetricEntries(report.aiOperability.details.highCouplingFiles, 'imports');
  const genericFiles = new Set(report.aiOperability.details.genericFiles);

  const rawFiles = await Promise.all(codeFiles.map(async (filePath) => {
    const contents = await safeRead(path.join(context.repoRoot, filePath));
    const imports = collectImportSpecifiers(contents);

    return {
      path: filePath,
      lineCount: countLines(contents),
      importCount: imports.length,
      localImports: dedupe(
        imports
          .map((specifier) => resolveLocalImport(filePath, specifier, codeFiles))
          .filter((value): value is string => value !== null),
      ),
    };
  }));

  const inboundCounts = new Map<string, number>();

  for (const file of rawFiles) {
    for (const target of file.localImports) {
      inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1);
    }
  }

  const files: FileMetric[] = rawFiles
    .map((file) => {
      const inboundCount = inboundCounts.get(file.path) ?? 0;
      const warnings = buildWarnings(file.path, file.lineCount, file.importCount, {
        largeFiles,
        highCouplingFiles,
        genericFiles,
      });
      const riskScore = computeRiskScore(file.lineCount, file.importCount, inboundCount, warnings.length);

      return {
        path: file.path,
        label: path.basename(file.path),
        lineCount: file.lineCount,
        importCount: file.importCount,
        inboundCount,
        riskScore,
        riskLabel: describeRisk(riskScore),
        warnings,
        ...buildAiGuidance(file.path, file.lineCount, file.importCount, inboundCount, warnings),
      };
    })
    .sort((left, right) => right.lineCount - left.lineCount || left.path.localeCompare(right.path));

  const tree = buildTree(files);
  summarizeTree(tree);

  return {
    meta: {
      repoRoot: context.repoRoot,
      projectLabel: report.projectLabel,
      score: report.aiOperability.score,
      packageManager: context.markers.packageManager ?? 'not detected',
      totalFiles: files.length,
      totalLines: files.reduce((total, file) => total + file.lineCount, 0),
      largestFiles: [...files].sort((left, right) => right.lineCount - left.lineCount).slice(0, 6),
      hardestFiles: [...files].sort((left, right) => right.riskScore - left.riskScore).slice(0, 6),
    },
    tree,
  };
}

function buildTree(files: FileMetric[]): TreeNode {
  const root: TreeNode = {
    id: 'root',
    name: 'root',
    path: 'root',
    kind: 'directory',
    value: 0,
    riskScore: 0,
    riskLabel: 'Low',
    warnings: [],
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split('/');
    let cursor = root;

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? '';
      const currentPath = parts.slice(0, index + 1).join('/');
      const isFile = index === parts.length - 1;

      if (isFile) {
        cursor.children = cursor.children ?? [];
        cursor.children.push({
          id: currentPath,
          name: part,
          path: currentPath,
          kind: 'file',
          value: Math.max(1, file.lineCount),
          riskScore: file.riskScore,
          riskLabel: file.riskLabel,
          warnings: file.warnings,
          file,
        });
        continue;
      }

      cursor.children = cursor.children ?? [];
      let next = cursor.children.find((child) => child.kind === 'directory' && child.name === part);

      if (!next) {
        next = {
          id: currentPath,
          name: part,
          path: currentPath,
          kind: 'directory',
          value: 0,
          riskScore: 0,
          riskLabel: 'Low',
          warnings: [],
          children: [],
        };
        cursor.children.push(next);
      }

      cursor = next;
    }
  }

  return root;
}

function summarizeTree(node: TreeNode): { value: number; riskScore: number } {
  if (node.kind === 'file') {
    return { value: node.value, riskScore: node.riskScore };
  }

  const children = node.children ?? [];
  const childSummaries = children.map((child) => summarizeTree(child));
  const totalValue = childSummaries.reduce((total, child) => total + child.value, 0);
  const weightedRisk = totalValue === 0
    ? 0
    : childSummaries.reduce((total, child, index) => total + child.riskScore * ((children[index]?.value ?? 0) / totalValue), 0);

  node.value = totalValue;
  node.riskScore = Math.round(weightedRisk);
  node.riskLabel = describeRisk(node.riskScore);
  node.children = children.sort((left, right) => right.value - left.value || left.name.localeCompare(right.name));

  return { value: node.value, riskScore: node.riskScore };
}

function computeRiskScore(
  lineCount: number,
  importCount: number,
  inboundCount: number,
  warningCount: number,
): number {
  const rawScore =
    Math.min(55, lineCount / 18)
    + Math.min(20, importCount * 1.2)
    + Math.min(15, inboundCount * 1.5)
    + warningCount * 9;

  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

function describeRisk(score: number): string {
  if (score >= 75) {
    return 'High';
  }

  if (score >= 45) {
    return 'Medium';
  }

  return 'Low';
}

function buildWarnings(
  filePath: string,
  lineCount: number,
  importCount: number,
  metrics: {
    largeFiles: Map<string, number>;
    highCouplingFiles: Map<string, number>;
    genericFiles: Set<string>;
  },
): string[] {
  const warnings: string[] = [];

  if (metrics.largeFiles.has(filePath) || lineCount >= 500) {
    warnings.push(`Large file (${metrics.largeFiles.get(filePath) ?? lineCount} lines)`);
  }

  if (metrics.highCouplingFiles.has(filePath) || importCount >= 15) {
    warnings.push(`Import-heavy (${metrics.highCouplingFiles.get(filePath) ?? importCount} imports)`);
  }

  if (metrics.genericFiles.has(filePath)) {
    warnings.push('Generic filename');
  }

  return warnings;
}

function buildAiGuidance(
  filePath: string,
  lineCount: number,
  importCount: number,
  inboundCount: number,
  warnings: string[],
): Pick<FileMetric, 'whyFlagged' | 'aiImpact' | 'recommendedActions' | 'safeTask'> {
  const pathLower = filePath.toLowerCase();
  const whyFlagged: string[] = [];
  const aiImpact: string[] = [];
  const recommendedActions: string[] = [];

  if (lineCount >= 1000) {
    whyFlagged.push(`Very large edit surface at ${lineCount} lines`);
    aiImpact.push('An agent has to hold too much local context to make small changes safely.');
    recommendedActions.push('Split the file into smaller feature-level modules before broad behavior changes.');
  } else if (lineCount >= 500) {
    whyFlagged.push(`Large file at ${lineCount} lines`);
    aiImpact.push('Edits are more likely to touch unrelated code because the file mixes too much context.');
    recommendedActions.push('Extract child components or helpers so future tasks can target narrower files.');
  }

  if (importCount >= 25) {
    whyFlagged.push(`Acts like an orchestration hub with ${importCount} imports`);
    aiImpact.push('High import fan-in usually means more blast radius and more hidden coupling for AI edits.');
    recommendedActions.push('Move orchestration, derived data, or command wiring into smaller collaborators.');
  } else if (importCount >= 15) {
    whyFlagged.push(`Import-heavy with ${importCount} imports`);
    aiImpact.push('Many dependencies increase the chance that a focused change breaks adjacent flows.');
    recommendedActions.push('Separate render logic from data shaping, handlers, or selectors.');
  }

  if (inboundCount >= 6) {
    whyFlagged.push(`Referenced by ${inboundCount} local modules`);
    aiImpact.push('Changes here are more likely to propagate broadly because many modules depend on it.');
    recommendedActions.push('Stabilize the API surface and extract internals behind smaller focused exports.');
  }

  if (/(toolbar|header|sidebar|drawer|panel|modal)/.test(pathLower)) {
    whyFlagged.push('UI shell file likely mixes layout with command/state logic');
    aiImpact.push('AI can misread visual edits as safe when the file also owns workflow or permission logic.');
    recommendedActions.push('Extract presentational sections from command wiring and permission logic.');
  }

  if (/(table|list|grid)/.test(pathLower)) {
    whyFlagged.push('List rendering files often combine data shaping and view logic');
    aiImpact.push('Sorting, filtering, and rendering changes can silently alter behavior across the screen.');
    recommendedActions.push('Move row shaping, filtering, and column config into pure helpers or selectors.');
  }

  if (/(page|route|screen)/.test(pathLower)) {
    whyFlagged.push('Top-level screen file likely owns too many responsibilities');
    aiImpact.push('AI edits at the screen level often blend loading, actions, and rendering in one patch.');
    recommendedActions.push('Push data fetching and actions into hooks/services and keep the screen mostly compositional.');
  }

  if (warnings.some((warning) => warning.includes('Generic filename'))) {
    whyFlagged.push('Filename does not clearly communicate ownership');
    aiImpact.push('Weak naming makes it harder for AI to choose the right edit target confidently.');
    recommendedActions.push('Rename the file around domain ownership before asking for larger refactors.');
  }

  if (recommendedActions.length === 0) {
    recommendedActions.push('Keep changes narrowly scoped and extract the first obvious subcomponent before deeper refactors.');
  }

  if (whyFlagged.length === 0) {
    whyFlagged.push('Selected mostly for size within the current repo view.');
  }

  if (aiImpact.length === 0) {
    aiImpact.push('This area still benefits from narrow, isolated changes instead of broad edits.');
  }

  return {
    whyFlagged: dedupe(whyFlagged).slice(0, 3),
    aiImpact: dedupe(aiImpact).slice(0, 3),
    recommendedActions: dedupe(recommendedActions).slice(0, 4),
    safeTask: buildSafeTaskSuggestion(filePath, lineCount, importCount),
  };
}

function buildSafeTaskSuggestion(filePath: string, lineCount: number, importCount: number): string {
  const baseName = path.basename(filePath).replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');

  if (/(toolbar|header|sidebar|drawer|panel|modal)/i.test(filePath)) {
    return `Extract one visual subsection from ${baseName} into a child component without changing behavior.`;
  }

  if (/(table|list|grid)/i.test(filePath)) {
    return `Move derived row shaping from ${baseName} into a pure helper and keep rendering unchanged.`;
  }

  if (lineCount >= 800 || importCount >= 20) {
    return `Split one responsibility out of ${baseName} first, then make the requested behavior change in a second step.`;
  }

  return `Make a single narrow change in ${baseName} and avoid mixing structural refactors into the same task.`;
}

function parseMetricEntries(entries: string[], unit: 'lines' | 'imports'): Map<string, number> {
  const output = new Map<string, number>();
  const pattern = unit === 'lines'
    ? /^(.*)\s+\((\d+)\s+lines\)$/
    : /^(.*)\s+\((\d+)\s+imports\)$/;

  for (const entry of entries) {
    const match = entry.match(pattern);

    if (!match) {
      continue;
    }

    const [, filePath, rawCount] = match;
    output.set(filePath, Number(rawCount));
  }

  return output;
}

function collectImportSpecifiers(contents: string | null): string[] {
  if (!contents) {
    return [];
  }

  const matches = contents.matchAll(
    /from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g,
  );

  return [...matches]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter(Boolean);
}

function resolveLocalImport(fromFile: string, specifier: string, allFiles: string[]): string | null {
  if (!specifier.startsWith('.')) {
    return null;
  }

  const basePath = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
    `${basePath}/index.js`,
    `${basePath}/index.jsx`,
    `${basePath}/index.mjs`,
    `${basePath}/index.cjs`,
  ];

  for (const candidate of candidates) {
    if (allFiles.includes(candidate)) {
      return candidate;
    }

    if (candidate.endsWith('.js')) {
      const tsCandidate = candidate.replace(/\.js$/, '.ts');

      if (allFiles.includes(tsCandidate)) {
        return tsCandidate;
      }
    }
  }

  return null;
}

function countLines(contents: string | null): number {
  if (!contents) {
    return 0;
  }

  return contents.split('\n').length;
}

function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

async function safeRead(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf8');
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderArchitectureMapHtml(data: ArchitectureMapData): string {
  const serializedData = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agento Architecture Map</title>
    <style>
      :root {
        --bg: #eef2f7;
        --panel: rgba(255, 255, 255, 0.72);
        --panel-soft: rgba(255, 255, 255, 0.82);
        --panel-strong: rgba(245, 247, 251, 0.92);
        --line: rgba(148, 163, 184, 0.22);
        --line-strong: rgba(99, 102, 241, 0.18);
        --text: #172033;
        --muted: #66748d;
        --risk-low: #34c759;
        --risk-mid: #64d2ff;
        --risk-elevated: #ffd60a;
        --risk-high: #ff9f0a;
        --risk-critical: #ff453a;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        color: var(--text);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(100, 210, 255, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(175, 82, 222, 0.14), transparent 24%),
          linear-gradient(180deg, #f8fbff 0%, var(--bg) 46%, #e9eef7 100%);
      }

      .shell {
        min-height: 100vh;
        padding: 8px;
      }

      .hero,
      .treemap-shell {
        border: 1px solid var(--line);
        border-radius: 16px;
        background: var(--panel);
        box-shadow:
          0 18px 40px rgba(15, 23, 42, 0.08),
          inset 0 1px 0 rgba(255, 255, 255, 0.65);
        backdrop-filter: blur(18px);
      }

      .hero {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: nowrap;
        min-height: 60px;
        max-height: 68px;
        padding: 6px 10px;
        overflow: hidden;
      }

      .stats {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        flex: 1 1 auto;
      }

      .stat {
        min-width: 112px;
        height: 48px;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--panel-soft);
        border: 1px solid var(--line);
        display: grid;
        align-content: center;
        flex: 0 0 auto;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
      }

      .stat-label {
        font-size: 10px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .stat-value {
        margin-top: 2px;
        font-size: 0.94rem;
        font-weight: 700;
      }

      .selection-stat {
        min-width: 0;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        overflow: hidden;
        flex: 1 1 auto;
      }

      .selection-title {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        flex: 0 0 auto;
      }

      .selection-name {
        flex: 0 1 180px;
        font-size: 0.82rem;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .selection-path {
        flex: 0 1 260px;
        font-size: 11px;
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .selection-summary {
        display: flex;
        gap: 4px;
        flex-wrap: nowrap;
        flex: 1 1 auto;
        overflow: hidden;
        min-width: 0;
        max-height: none;
      }

      .selection-grid {
        display: flex;
        gap: 4px;
        flex-wrap: nowrap;
        overflow: hidden;
        flex: 0 0 auto;
      }

      .selection-metric {
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--panel-strong);
        border: 1px solid var(--line);
        white-space: nowrap;
        flex: 0 0 auto;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
      }

      .selection-metric-label {
        font-size: 9px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .selection-metric-value {
        font-size: 11px;
        font-weight: 700;
      }

      .controls {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 8px;
      }

      .controls input,
      .controls button {
        appearance: none;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel);
        color: var(--text);
        padding: 8px 12px;
        font: inherit;
        box-shadow:
          0 10px 24px rgba(15, 23, 42, 0.06),
          inset 0 1px 0 rgba(255, 255, 255, 0.82);
        backdrop-filter: blur(16px);
      }

      .controls input {
        flex: 1;
        min-width: 280px;
      }

      .treemap-shell {
        position: relative;
        padding: 6px;
        min-height: calc(100vh - 126px);
      }

      .treemap {
        position: relative;
        width: 100%;
        height: calc(100vh - 142px);
        min-height: 560px;
        border-radius: 12px;
        overflow: hidden;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.16)),
          #dfe7f3;
      }

      .node {
        position: absolute;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.42);
        border-radius: 3px;
        padding: 0;
        text-align: left;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28);
      }

      .node.directory {
        border-radius: 2px;
      }

      .node.selected {
        border-color: #ffffff;
        z-index: 2;
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.42),
          0 0 0 2px rgba(10, 132, 255, 0.3);
      }

      .node-content {
        position: absolute;
        inset: 0;
        padding: 4px 5px;
        display: flex;
        flex-direction: column;
        gap: 2px;
        justify-content: flex-start;
      }

      .node-name {
        font-size: 10px;
        font-weight: 700;
        line-height: 1.05;
        overflow: hidden;
        word-break: break-word;
      }

      .node-meta {
        font-size: 8px;
        color: rgba(23, 32, 51, 0.72);
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .node.micro .node-content {
        padding: 2px 3px;
      }

      .node.micro .node-name {
        font-size: 8px;
        line-height: 1.05;
      }

      .node.micro .node-meta {
        display: none;
      }

      .node.nano .node-content {
        display: none;
      }

      .pill {
        display: inline-flex;
        width: fit-content;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(10, 132, 255, 0.1);
        border: 1px solid rgba(10, 132, 255, 0.16);
        font-size: 11px;
      }

      .signal-pill {
        display: inline-flex;
        align-items: center;
        max-width: 220px;
        min-width: 0;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 10px;
        font-weight: 700;
        line-height: 1.2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 0 1 auto;
      }

      .signal-low {
        background: rgba(52, 199, 89, 0.16);
        border-color: rgba(52, 199, 89, 0.3);
        color: #1f6f39;
      }

      .signal-medium {
        background: rgba(100, 210, 255, 0.16);
        border-color: rgba(100, 210, 255, 0.34);
        color: #0c5f81;
      }

      .signal-elevated {
        background: rgba(255, 214, 10, 0.18);
        border-color: rgba(255, 214, 10, 0.34);
        color: #8c6a00;
      }

      .signal-high {
        background: rgba(255, 159, 10, 0.18);
        border-color: rgba(255, 159, 10, 0.34);
        color: #915500;
      }

      .signal-critical {
        background: rgba(255, 69, 58, 0.16);
        border-color: rgba(255, 69, 58, 0.3);
        color: #9f241c;
      }

      @media (max-width: 1100px) {
        .shell {
          padding: 8px;
        }

        .hero {
          display: grid;
          grid-template-columns: 1fr;
          max-height: none;
          min-height: 0;
        }

        .stat {
          min-width: 0;
          height: auto;
        }

        .selection-grid {
          gap: 4px;
        }

        .selection-stat {
          flex-direction: column;
          align-items: flex-start;
        }

        .selection-summary {
          flex-wrap: wrap;
        }

        .treemap {
          height: calc(100vh - 260px);
          min-height: 440px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <main>
        <section class="hero">
          <div class="stats">
            <div class="stat"><div class="stat-label">AI operability</div><div class="stat-value">${data.meta.score}/100</div></div>
            <div class="stat"><div class="stat-label">Mapped files</div><div class="stat-value">${data.meta.totalFiles}</div></div>
            <div class="stat selection-stat" id="detailPanel">
              <div class="selection-title">
                <div class="stat-label">Selection</div>
                <div class="pill">No selection</div>
              </div>
              <div class="selection-name">Click any box</div>
              <div class="selection-path">Selection details will appear here.</div>
            </div>
          </div>
        </section>

        <div class="controls">
          <input id="searchInput" type="search" placeholder="Filter by path or filename" />
          <button id="resetButton" type="button">Reset</button>
        </div>

        <section class="treemap-shell">
          <div class="treemap" id="treemap"></div>
        </section>
      </main>
    </div>

    <script id="map-data" type="application/json">${serializedData}</script>
    <script>
      const data = JSON.parse(document.getElementById('map-data').textContent);
      const treemap = document.getElementById('treemap');
      const searchInput = document.getElementById('searchInput');
      const resetButton = document.getElementById('resetButton');
      const detailPanel = document.getElementById('detailPanel');

      const state = {
        query: '',
        selectedPath: null,
      };

      const MIN_NODE_SIZE = 18;
      const MIN_RECURSE_AREA = 2200;
      const MIN_RECURSE_WIDTH = 72;
      const MIN_RECURSE_HEIGHT = 44;

      function riskColor(score) {
        if (score >= 85) {
          return 'var(--risk-critical)';
        }
        if (score >= 70) {
          return 'var(--risk-high)';
        }
        if (score >= 55) {
          return 'var(--risk-elevated)';
        }
        if (score >= 35) {
          return 'var(--risk-mid)';
        }
        return 'var(--risk-low)';
      }

      function nodeMatches(node, query) {
        if (!query) {
          return true;
        }

        if (node.path.toLowerCase().includes(query) || node.name.toLowerCase().includes(query)) {
          return true;
        }

        return (node.children || []).some((child) => nodeMatches(child, query));
      }

      function filterTree(node, query) {
        if (!query) {
          return node;
        }

        if (node.kind === 'file') {
          return nodeMatches(node, query) ? node : null;
        }

        const children = (node.children || [])
          .map((child) => filterTree(child, query))
          .filter(Boolean);

        if (children.length === 0 && !nodeMatches(node, query)) {
          return null;
        }

        return { ...node, children };
      }

      function summarize(node) {
        if (node.kind === 'file') {
          return { value: node.value, riskScore: node.riskScore };
        }

        const children = node.children || [];
        const childSummaries = children.map((child) => summarize(child));
        const total = childSummaries.reduce((sum, child) => sum + child.value, 0);
        const weighted = total === 0 ? 0 : childSummaries.reduce((sum, child) => sum + child.riskScore * child.value, 0) / total;

        return { value: total, riskScore: Math.round(weighted) };
      }

      function layoutChildren(children, x, y, width, height, depth) {
        if (!children || children.length === 0) {
          return [];
        }

        const total = children.reduce((sum, child) => sum + Math.max(child.value, 1), 0);
        let cursor = 0;
        const horizontal = width >= height;
        const rects = [];

        children.forEach((child) => {
          const ratio = Math.max(child.value, 1) / total;
          const childWidth = horizontal ? width * ratio : width;
          const childHeight = horizontal ? height : height * ratio;
          const childX = horizontal ? x + cursor : x;
          const childY = horizontal ? y : y + cursor;

          rects.push({
            node: child,
            x: childX,
            y: childY,
            width: childWidth,
            height: childHeight,
            depth,
          });

          cursor += horizontal ? childWidth : childHeight;
        });

        return rects;
      }

      function renderNode(node, x, y, width, height, depth, fragment) {
        if (width < MIN_NODE_SIZE || height < MIN_NODE_SIZE) {
          return;
        }

        const el = document.createElement('button');
        el.type = 'button';
        let sizeClass = '';

        if (width < 46 || height < 24) {
          sizeClass = ' nano';
        } else if (width < 82 || height < 40) {
          sizeClass = ' micro';
        }

        el.className = 'node ' + node.kind + sizeClass;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.width = width + 'px';
        el.style.height = height + 'px';
        el.style.background = riskColor(node.riskScore);
        el.style.opacity = String(Math.max(0.78, 1 - depth * 0.03));
        if (state.selectedPath === node.path) {
          el.classList.add('selected');
        }
        el.title = node.path;
        el.setAttribute('aria-label', node.path);

        if (width >= 56 && height >= 26) {
          const content = document.createElement('div');
          content.className = 'node-content';
          const primaryLabel = node.kind === 'file' ? node.name.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '') : node.name;
          const metaLabel = node.kind === 'file'
            ? node.file.lineCount + ' lines'
            : (node.children || []).length + ' items';
          content.innerHTML =
            '<div class="node-name">' + primaryLabel + '</div>'
            + (width >= 90 && height >= 42 ? '<div class="node-meta">' + metaLabel + '</div>' : '');
          el.appendChild(content);
        }

        el.addEventListener('click', () => {
          state.selectedPath = node.path;
          updateDetail(node);
        });
        fragment.appendChild(el);

        if (
          node.kind === 'directory'
          && width * height >= MIN_RECURSE_AREA
          && width >= MIN_RECURSE_WIDTH
          && height >= MIN_RECURSE_HEIGHT
        ) {
          const padding = depth === 0 ? 6 : 2;
          const childRects = layoutChildren(
            node.children || [],
            x + padding,
            y + padding,
            Math.max(0, width - padding * 2),
            Math.max(0, height - padding * 2),
            depth + 1,
          );

          childRects.forEach((rect) => renderNode(rect.node, rect.x, rect.y, rect.width, rect.height, rect.depth, fragment));
        }
      }

      function escapeInlineHtml(value) {
        return value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function signalTone(score) {
        if (score >= 85) {
          return 'critical';
        }
        if (score >= 70) {
          return 'high';
        }
        if (score >= 55) {
          return 'elevated';
        }
        if (score >= 35) {
          return 'medium';
        }
        return 'low';
      }

      function buildSignalPills(node) {
        const pills = [];

        node.warnings.forEach((warning) => {
          pills.push({ tone: signalTone(node.riskScore + 15), label: warning });
        });

        if (node.kind === 'file') {
          node.file.aiImpact.slice(0, 2).forEach((item) => {
            pills.push({ tone: signalTone(node.riskScore), label: item });
          });

          node.file.recommendedActions.slice(0, 2).forEach((item) => {
            pills.push({ tone: signalTone(Math.max(20, node.riskScore - 10)), label: item });
          });

          if (node.file.safeTask) {
            pills.push({ tone: 'low', label: node.file.safeTask });
          }
        } else if (node.warnings.length === 0) {
          pills.push({ tone: 'medium', label: 'Contains ' + (node.children || []).length + ' mapped items' });
        }

        return pills.slice(0, 6);
      }

      function renderSignalPills(node) {
        const pills = buildSignalPills(node);

        if (pills.length === 0) {
          return '';
        }

        return '<div class="selection-summary">'
          + pills
            .map((pill) => '<div class="signal-pill signal-' + pill.tone + '" title="' + escapeInlineHtml(pill.label) + '">'
              + escapeInlineHtml(pill.label)
              + '</div>')
            .join('')
          + '</div>';
      }

      function updateDetail(node) {
        const metrics = node.kind === 'file'
          ? [
            ['Lines', String(node.file.lineCount)],
            ['Imports', String(node.file.importCount)],
            ['Inbound', String(node.file.inboundCount)],
            ['Risk', node.riskScore + '/100'],
          ]
          : [
            ['Items', String((node.children || []).length)],
            ['Total lines', String(node.value)],
            ['Risk', node.riskScore + '/100'],
          ];
        const metricMarkup = metrics
          .map((entry) =>
            '<div class="selection-metric"><div class="selection-metric-label">' + entry[0] + '</div><div class="selection-metric-value">' + entry[1] + '</div></div>')
          .join('');

        detailPanel.innerHTML =
          '<div class="selection-title">'
          + '<div class="stat-label">Selection</div>'
          + '<div class="pill">' + node.riskLabel + ' risk</div>'
          + '</div>'
          + '<div class="selection-name">' + node.name + '</div>'
          + '<div class="selection-path">' + node.path + '</div>'
          + '<div class="selection-grid">' + metricMarkup + '</div>'
          + renderSignalPills(node);
      }

      function resetDetail() {
        state.selectedPath = null;
        detailPanel.innerHTML =
          '<div class="selection-title">'
          + '<div class="stat-label">Selection</div>'
          + '<div class="pill">No selection</div>'
          + '</div>'
          + '<div class="selection-name">Click any box</div>'
          + '<div class="selection-path">Selection details will appear here.</div>'
          + '<div class="selection-grid">'
          + '<div class="selection-metric"><div class="selection-metric-label">Status</div><div class="selection-metric-value">Ready</div></div>'
          + '</div>'
          + '<div class="selection-summary">'
          + '<div class="signal-pill signal-low">Safe task suggestions</div>'
          + '<div class="signal-pill signal-medium">AI struggle notes</div>'
          + '<div class="signal-pill signal-high">Hotspot warnings</div>'
          + '<div class="signal-pill signal-elevated">Recommended actions</div>'
          + '</div>';
      }

      function render() {
        treemap.innerHTML = '';
        const query = state.query.trim().toLowerCase();
        const filteredTree = filterTree(data.tree, query);

        if (!filteredTree || !(filteredTree.children || []).length) {
          treemap.innerHTML = '<div style="padding: 20px; color: var(--muted);">No files matched this filter.</div>';
          return;
        }

        const summary = summarize(filteredTree);
        filteredTree.value = summary.value;
        filteredTree.riskScore = summary.riskScore;
        const fragment = document.createDocumentFragment();
        renderNode(filteredTree, 0, 0, treemap.clientWidth, treemap.clientHeight, 0, fragment);
        treemap.appendChild(fragment);
      }

      let renderFrame = null;

      function scheduleRender() {
        if (renderFrame !== null) {
          cancelAnimationFrame(renderFrame);
        }

        renderFrame = requestAnimationFrame(() => {
          renderFrame = null;
          render();
        });
      }

      searchInput.addEventListener('input', (event) => {
        state.query = event.target.value;
        scheduleRender();
      });

      resetButton.addEventListener('click', () => {
        state.query = '';
        searchInput.value = '';
        resetDetail();
        scheduleRender();
      });

      window.addEventListener('resize', scheduleRender);
      resetDetail();
      scheduleRender();
    </script>
  </body>
</html>`;
}
