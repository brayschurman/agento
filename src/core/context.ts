import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadPlanioConfig } from './config.js';
import { analyzeRepository } from './health-check.js';
import { scanRepository } from './repo-scan.js';

import type { ContextArtifact } from '../types/context.js';
import type { PlanioConfig } from '../types/config.js';
import type { HealthItem, HealthReport, RepoContext } from '../types/health.js';

const APP_CONTEXT_FILENAME = 'agento.md';
const IMPORTANT_COMMANDS = ['build', 'dev', 'test', 'lint', 'format', 'typecheck', 'health'];

export async function buildContextArtifact(repoRoot: string): Promise<ContextArtifact> {
  const [config, context, report] = await Promise.all([
    loadPlanioConfig(repoRoot),
    scanRepository(repoRoot),
    analyzeRepository(repoRoot),
  ]);
  const outputPath = path.join(repoRoot, APP_CONTEXT_FILENAME);
  const markdown = await renderContextMarkdown(context, config, report);

  return {
    markdown,
    outputPath,
  };
}

export async function generateContextArtifact(repoRoot: string): Promise<ContextArtifact> {
  const artifact = await buildContextArtifact(repoRoot);

  await writeFile(artifact.outputPath, `${artifact.markdown}\n`, 'utf8');

  return artifact;
}

async function renderContextMarkdown(
  context: RepoContext,
  config: PlanioConfig,
  report: HealthReport,
): Promise<string> {
  const summary = buildRepoSummary(context, report);
  const keyDirectories = pickKeyDirectories(context);
  const importantCommands = pickImportantCommands(context);
  const architectureRules = buildArchitectureRules(config);
  const dangerousAreas = buildDangerousAreas(report);
  const topWarnings = buildTopWarnings(report);
  const agentGuidance = buildAgentGuidance(config, report);
  const boundaryViolations = buildBoundaryViolations(report);
  const readmeExcerpt = await readDocExcerpt(context.repoRoot, ['README.md', 'readme.md']);
  const architectureExcerpt = await readDocExcerpt(context.repoRoot, [
    'docs/architecture.md',
    'architecture.md',
    'ARCHITECTURE.md',
  ]);

  return [
    '# Agento Context',
    '',
    '## Repository',
    '',
    `- Name: ${context.packageManifest?.name ?? path.basename(context.repoRoot)}`,
    `- Root: \`${context.repoRoot}\``,
    `- Package manager: ${context.markers.packageManager ?? 'not detected'}`,
    `- Project label: ${report.projectLabel}`,
    '',
    '## Summary',
    '',
    summary,
    ...(readmeExcerpt
      ? [
        '',
        '## README Highlights',
        '',
        readmeExcerpt,
      ]
      : []),
    ...(architectureExcerpt
      ? [
        '',
        '## Architecture Notes',
        '',
        architectureExcerpt,
      ]
      : []),
    '',
    '## Key Directories',
    '',
    ...renderBulletList(keyDirectories),
    '',
    '## Important Commands',
    '',
    ...renderBulletList(importantCommands),
    '',
    '## Engineering Expectations',
    '',
    ...renderBulletList(buildExpectations(config)),
    ...(architectureRules.length > 0
      ? [
        '',
        '## Architecture Rules',
        '',
        ...renderBulletList(architectureRules),
      ]
      : []),
    '',
    '## Current Risks',
    '',
    ...renderBulletList(topWarnings),
    ...(boundaryViolations.length > 0
      ? [
        '',
        '## Boundary Violations',
        '',
        ...renderBulletList(boundaryViolations),
      ]
      : []),
    '',
    '## Dangerous Areas',
    '',
    ...renderBulletList(dangerousAreas),
    '',
    '## Guidance For AI Agents',
    '',
    ...renderBulletList(agentGuidance),
  ].join('\n');
}

function buildRepoSummary(context: RepoContext, report: HealthReport): string {
  const sourceRoots = context.directories.filter((directory) =>
    ['src', 'app', 'packages', 'server', 'client'].includes(directory),
  );
  const sourceText = sourceRoots.length > 0 ? sourceRoots.join(', ') : 'no obvious source root';
  const article = /^[aeiou]/i.test(report.projectLabel) ? 'an' : 'a';

  return `This repository is currently identified as ${article} ${report.projectLabel}. Primary source areas: ${sourceText}. The current AI operability score is ${report.aiOperability.score}/100.`;
}

function pickKeyDirectories(context: RepoContext): string[] {
  const directories = context.directories.filter((directory) =>
    ['src', 'app', 'packages', 'server', 'client', 'docs', 'scripts', 'tests', 'test', 'Formula', 'dist'].includes(directory),
  );

  if (directories.length > 0) {
    return directories.map((directory) => `\`${directory}/\``);
  }

  return ['No major top-level directories were detected yet'];
}

function pickImportantCommands(context: RepoContext): string[] {
  const scripts = context.packageManifest?.scripts ?? {};
  const matches = IMPORTANT_COMMANDS.filter((command) => scripts[command]).map((command) => `\`${command}\`: \`${scripts[command]}\``);

  if (matches.length > 0) {
    return matches;
  }

  return ['No common npm scripts detected'];
}

function buildExpectations(config: PlanioConfig): string[] {
  const expectations: string[] = [
    `Keep code files under ${Math.max(1, config.rules.files.maxLines)} lines where practical`,
  ];

  if (config.rules.files.genericNames !== 'off') {
    expectations.push(`Avoid generic filenames like \`utils.ts\` or \`helpers.ts\` (${config.rules.files.genericNames})`);
  }

  if (config.rules.docs.requireReadme) {
    expectations.push('Maintain a README with setup and workflow context');
  }

  if (config.rules.docs.requireArchitectureDoc) {
    expectations.push('Maintain architecture documentation for major layers and flows');
  }

  if (config.rules.docs.requirePlanioMd) {
    expectations.push('Keep `agento.md` up to date for AI assistant context');
  }

  if (config.rules.architecture.requiredDirs.length > 0) {
    expectations.push(`Preserve configured architecture directories: ${config.rules.architecture.requiredDirs.map((item) => `\`${item}/\``).join(', ')}`);
  }

  return expectations;
}

function buildArchitectureRules(config: PlanioConfig): string[] {
  const rules: string[] = [];

  if (config.rules.architecture.requiredDirs.length > 0) {
    rules.push(`Required directories: ${config.rules.architecture.requiredDirs.map((item) => `\`${item}/\``).join(', ')}`);
  }

  if (config.rules.architecture.bannedImports.length > 0) {
    rules.push(
      ...config.rules.architecture.bannedImports.map(
        (rule) => `Do not import from \`${rule.from}/\` into \`${rule.to}/\` boundaries`,
      ),
    );
  }

  return rules;
}

function buildTopWarnings(report: HealthReport): string[] {
  const items = report.sections
    .flatMap((section) => section.items)
    .filter((item) => item.status !== 'pass')
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .slice(0, 5)
    .map((item) => item.message);

  return items.length > 0 ? items : ['No major health warnings detected'];
}

function buildDangerousAreas(report: HealthReport): string[] {
  const coupling = report.aiOperability.details.highCouplingFiles.map((file) => `High coupling: ${file}`);
  const oversize =
    report.aiOperability.details.largeFilesOverLimit > 0
      ? [
        `${report.aiOperability.details.largeFilesOverLimit} files exceed the configured line limit of ${report.aiOperability.details.largeFileLimit}`,
      ]
      : [];
  const warningFixes = report.aiOperability.warnings
    .filter((item) => item.remediation)
    .slice(0, 3)
    .map((item) => `${item.message} -> ${item.remediation}`);
  const items = [...coupling, ...oversize, ...warningFixes];

  return items.length > 0 ? items : ['No obvious high-risk areas were detected from the current heuristics'];
}

function buildBoundaryViolations(report: HealthReport): string[] {
  return report.sections
    .find((section) => section.title === 'Architectural Legibility')
    ?.items.filter((item) => item.message.startsWith('Banned import boundary violations:'))
    .map((item) => item.message.replace('Banned import boundary violations: ', ''))
    ?? [];
}

function buildAgentGuidance(config: PlanioConfig, report: HealthReport): string[] {
  const guidance = [
    'Read this file before making structural changes',
    'Prefer small, isolated edits over broad rewrites',
    'Preserve existing directory boundaries and naming conventions',
  ];

  if (config.rules.architecture.bannedImports.length > 0) {
    guidance.push('Respect configured import boundaries even when a direct import would be faster');
  }

  if (config.rules.docs.requirePlanioMd) {
    guidance.push('Update `agento.md` when architecture, workflow, or key commands change');
  }

  if (report.aiOperability.score <= 60) {
    guidance.push('Use extra caution in this repo: the current operability score indicates structural friction for AI-assisted edits');
  }

  if (report.sections.some((section) => section.title === 'Change Safety' && section.items.some((item) => item.status === 'fail'))) {
    guidance.push('Testing coverage is weak or missing, so validate changes conservatively');
  }

  return guidance;
}

function renderBulletList(items: string[]): string[] {
  return items.map((item) => `- ${item}`);
}

async function readDocExcerpt(repoRoot: string, relativePaths: string[]): Promise<string | null> {
  for (const relativePath of relativePaths) {
    const targetPath = path.join(repoRoot, relativePath);

    try {
      const contents = await readFile(targetPath, 'utf8');
      const excerpt = summarizeMarkdown(contents);

      if (excerpt) {
        return excerpt;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function summarizeMarkdown(contents: string): string | null {
  const lines = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const usefulLines = lines.filter((line) => !line.startsWith('```'));
  const prioritizedLines = usefulLines.filter((line) =>
    line.startsWith('#') || (!line.startsWith('-') && !/^\d+\./.test(line)),
  );
  const excerptLines = (prioritizedLines.length > 0 ? prioritizedLines : usefulLines).slice(0, 6);

  if (excerptLines.length === 0) {
    return null;
  }

  return excerptLines.join('\n\n');
}
