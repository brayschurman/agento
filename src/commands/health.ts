import chalk from 'chalk';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { analyzeRepository } from '../core/health-check.js';
import { detectRepositoryRoot } from '../core/repo-scan.js';
import type {
  AgentHostileArea,
  AiOperabilitySubscore,
  HealthCommandOutput,
  HealthItem,
  HealthSection,
  HealthSummary,
} from '../types/health.js';

export interface RunHealthCommandOptions {
  format?: 'text' | 'json';
  summary?: boolean;
}

export async function runHealthCommand(
  startDirectory: string,
  options: RunHealthCommandOptions = {},
): Promise<void> {
  const repoRoot = await detectRepositoryRoot(startDirectory);

  if (!repoRoot) {
    const message = 'No repository root detected from the current directory.';

    if (options.format === 'json') {
      console.error(JSON.stringify({ error: message }, null, 2));
    } else {
      console.error(chalk.red(message));
    }

    process.exitCode = 1;
    return;
  }

  const report = await analyzeRepository(repoRoot);
  const output = buildCommandOutput(report);

  if (options.format === 'json') {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (options.summary) {
    await renderFullSummary(output);
    return;
  }

  await renderCompactSummary(output);
}

interface SectionGrade {
  label: string;
  score: number;
  color: typeof chalk.greenBright;
}

interface SectionView {
  title: string;
  grade: SectionGrade;
  summary: string;
  items: HealthItem[];
  details: string[];
}

async function renderFullSummary(output: HealthCommandOutput): Promise<void> {
  const { report } = output;

  await renderHeader(report.projectLabel, report.repoRoot, report.aiOperability.score);
  await renderScoreBreakdown(report.aiOperability.subscores);
  await renderAgentHostileAreas(report.repoRoot, report.aiOperability.details.agentHostileAreas);
  await renderTaskFrictionWarnings(output.taskFrictionWarnings);
  await renderLargeFiles(
    report.repoRoot,
    report.aiOperability.details.largeFilePaths,
    report.aiOperability.details.hugeFilePaths,
    report.aiOperability.details.largeFileLimit,
  );
  await renderGenericFiles(report.repoRoot, report.aiOperability.details.genericFiles);
  await renderHighCouplingFiles(report.repoRoot, report.aiOperability.details.highCouplingFiles);
  await renderStructuralSignals(report);
  await renderRecommendedFixes(output.recommendedFixes);
  renderFootnote(output.summary);
}

async function renderCompactSummary(output: HealthCommandOutput): Promise<void> {
  const sectionViews = output.report.sections.map((section) => buildSectionView(output, section));

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    renderCompactStatic(output, sectionViews);
    return;
  }

  await runInteractiveSectionViewer(output, sectionViews);
}

function renderCompactStatic(output: HealthCommandOutput, sectionViews: SectionView[]): void {
  const { report, summary } = output;
  const overallGrade = getLetterGrade(report.aiOperability.score);

  console.log(chalk.bold('AGENTO AI OPERABILITY'));
  console.log(chalk.dim(`${report.projectLabel} | ${report.repoRoot}`));
  console.log('');
  console.log(
    `Score: ${overallGrade.color.bold(`${report.aiOperability.score}/100`)} ${overallGrade.color(`(${overallGrade.label})`)}`,
  );
  console.log(
    `Signals: ${chalk.red(`${summary.failures} fail`)} ${chalk.dim('•')} ${chalk.yellow(`${summary.warnings} warn`)} ${chalk.dim('•')} ${chalk.green(`${summary.passes} pass`)}`,
  );
  console.log('');
  console.log(chalk.bold('Sections'));

  sectionViews.forEach((section) => {
    console.log(`  ${section.title} ${formatGradeBadge(section.grade)}`);
  });
}

async function runInteractiveSectionViewer(
  output: HealthCommandOutput,
  sectionViews: SectionView[],
): Promise<void> {
  const state = {
    activeIndex: 0,
    inDetail: false,
  };
  const stdin = process.stdin;

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();

  const render = (): void => {
    process.stdout.write('\u001Bc');

    if (state.inDetail) {
      renderSectionDetail(output, sectionViews[state.activeIndex] as SectionView, state.activeIndex);
      return;
    }

    renderCompactInteractive(output, sectionViews, state.activeIndex);
  };

  render();

  await new Promise<void>((resolve) => {
    const onKeypress = (_input: string, key: readline.Key): void => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exitCode = 130;
        resolve();
        return;
      }

      if (state.inDetail) {
        if (key.name === 'return' || key.name === 'escape' || key.name === 'backspace' || _input === 'q') {
          state.inDetail = false;
          render();
        }

        return;
      }

      if (key.name === 'down') {
        state.activeIndex = (state.activeIndex + 1) % sectionViews.length;
        render();
        return;
      }

      if (key.name === 'up') {
        state.activeIndex = (state.activeIndex - 1 + sectionViews.length) % sectionViews.length;
        render();
        return;
      }

      if (key.name === 'return') {
        state.inDetail = true;
        render();
        return;
      }

      if (key.name === 'escape' || _input === 'q') {
        cleanup();
        resolve();
      }
    };

    const cleanup = (): void => {
      stdin.off('keypress', onKeypress);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\u001Bc');
      renderCompactStatic(output, sectionViews);
      console.log('');
    };

    stdin.on('keypress', onKeypress);
  });
}

function renderCompactInteractive(
  output: HealthCommandOutput,
  sectionViews: SectionView[],
  activeIndex: number,
): void {
  const { report, summary } = output;
  const overallGrade = getLetterGrade(report.aiOperability.score);

  console.log(chalk.bold('AGENTO AI OPERABILITY'));
  console.log(chalk.dim(`${report.projectLabel} | ${report.repoRoot}`));
  console.log('');
  console.log(
    `Score: ${renderMeter(report.aiOperability.score)} ${overallGrade.color.bold(`${report.aiOperability.score}/100`)} ${overallGrade.color(`(${overallGrade.label})`)}`,
  );
  console.log(
    `Signals: ${chalk.red(`${summary.failures} fail`)} ${chalk.dim('•')} ${chalk.yellow(`${summary.warnings} warn`)} ${chalk.dim('•')} ${chalk.green(`${summary.passes} pass`)}`,
  );
  console.log('');
  console.log(chalk.bold('Sections'));

  sectionViews.forEach((section, index) => {
    const isActive = index === activeIndex;
    const prefix = isActive ? chalk.cyanBright('›') : chalk.dim(' ');
    const line = `${section.title} ${formatGradeBadge(section.grade)}`;
    console.log(`  ${prefix} ${isActive ? chalk.bold(line) : line}`);
  });

  console.log('');
  console.log(chalk.dim('Use ↑/↓ to select, Enter to open, q or Esc to exit.'));
}

function renderSectionDetail(
  output: HealthCommandOutput,
  section: SectionView,
  index: number,
): void {
  const countLabel = `${index + 1}/${output.report.sections.length}`;

  console.log(chalk.bold(section.title), formatGradeBadge(section.grade), chalk.dim(countLabel));
  console.log(chalk.dim(section.summary));
  console.log('');

  section.items.forEach((item) => {
    const label = item.status === 'fail'
      ? chalk.red('HIGH')
      : item.status === 'warn'
        ? chalk.yellow('WARN')
        : chalk.green('PASS');

    console.log(`  ${getStatusEmoji(item.status)} ${chalk.dim('[')}${label}${chalk.dim(']')} ${item.message}`);

    if (item.remediation) {
      console.log(`     ${chalk.dim(item.remediation)}`);
    }

    if (item.evidence && item.evidence.length > 0) {
      console.log('');

      item.evidence.forEach((group) => {
        console.log(`     ${chalk.bold(group.label)}`);

        group.entries.forEach((entry) => {
          console.log(`       ${chalk.dim('-')} ${entry}`);
        });
      });
    }

    console.log('');
  });

  if (section.details.length > 0) {
    console.log(chalk.bold('  Files'));
    section.details.forEach((detail) => {
      console.log(`    ${chalk.dim('-')} ${detail}`);
    });
    console.log('');
  }

  console.log(chalk.dim('Press Enter, Backspace, or Esc to return. Press q to exit.'));
}

function buildSectionView(output: HealthCommandOutput, section: HealthSection): SectionView {
  const grade = gradeSection(section.items);

  return {
    title: section.title,
    grade,
    summary: buildSectionSummary(section, grade),
    items: section.items,
    details: buildSectionDetails(output, section),
  };
}

function buildSectionSummary(section: HealthSection, grade: SectionGrade): string {
  const failures = section.items.filter((item) => item.status === 'fail').length;
  const warnings = section.items.filter((item) => item.status === 'warn').length;
  const passes = section.items.filter((item) => item.status === 'pass').length;
  const statusLine = `${grade.label} section grade from ${passes} pass, ${warnings} warn, ${failures} fail`;

  if (!section.summary) {
    return statusLine;
  }

  return `${statusLine}. ${section.summary}`;
}

function buildSectionDetails(output: HealthCommandOutput, section: HealthSection): string[] {
  if (section.title === 'Code Discoverability') {
    return output.report.aiOperability.details.genericFiles
      .slice(0, 50)
      .map((file) => `Generic: ${formatPathForTerminal(output.report.repoRoot, file, { preferRelative: true })}`);
  }

  if (section.title === 'Context Density') {
    return output.report.aiOperability.details.largeFilePaths
      .slice(0, 50)
      .map((file) => `Large: ${formatFileEntry(output.report.repoRoot, file, { preferRelative: true })}`);
  }

  return [];
}

function buildCommandOutput(report: HealthCommandOutput['report']): HealthCommandOutput {
  const allItems = report.sections.flatMap((section) => section.items);
  const summary = buildSummary(allItems, report.aiOperability.warnings.length);
  const taskFrictionWarnings = buildTaskFrictionWarnings(report);
  const topIssues = dedupeItems(
    [...taskFrictionWarnings, ...allItems.filter((item) => item.status !== 'pass')],
  )
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .slice(0, 5);
  const recommendedFixes = dedupeItems(topIssues, 'remediation')
    .map((item) => item.remediation as string);

  return {
    summary,
    taskFrictionWarnings,
    topIssues,
    recommendedFixes,
    report,
  };
}

function buildSummary(items: HealthItem[], aiWarningCount: number): HealthSummary {
  return {
    failures: items.filter((item) => item.status === 'fail').length,
    warnings: items.filter((item) => item.status === 'warn').length + aiWarningCount,
    passes: items.filter((item) => item.status === 'pass').length,
  };
}

async function renderHeader(projectLabel: string, repoRoot: string, score: number): Promise<void> {
  const title = 'AGENTO AI OPERABILITY';
  const scoreLabel = `${score}/100`;
  const grade = getScoreLabel(score);
  const subtitle = `${projectLabel} | ${repoRoot}`;
  const scoreLine = `Score: ${scoreLabel} (${grade.label}) ${grade.emoji}`;
  const width = Math.max(title.length, subtitle.length, scoreLine.length) + 4;
  const border = `+${'-'.repeat(width + 2)}+`;

  console.log(grade.color(border));
  console.log(grade.color(`| ${title.padEnd(width)} |`));
  console.log(grade.color(`| ${scoreLine.padEnd(width)} |`));
  console.log(chalk.dim(`| ${subtitle.padEnd(width)} |`));
  console.log(grade.color(border));
  console.log('');
  console.log(`  ${renderMeter(score)} ${grade.color.bold(scoreLabel)}`);
  console.log(`  ${chalk.dim('Status:')} ${grade.color(grade.label)}`);
  console.log('');
  await pause();
}

async function renderScoreBreakdown(subscores: AiOperabilitySubscore[]): Promise<void> {
  renderSectionTitle('Subscores');

  for (const subscore of subscores) {
    const color = getScoreColor(subscore.score);
    const weight = `${Math.round(subscore.weight * 100)}%`;
    console.log(`  ${subscore.label.padEnd(24)} ${color(renderMiniMeter(subscore.score))} ${color.bold(`${subscore.score}`)} ${chalk.dim(`weight ${weight}`)}`);
  }

  console.log('');
  await pause();
}

async function renderAgentHostileAreas(
  repoRoot: string,
  areas: AgentHostileArea[],
): Promise<void> {
  renderSectionTitle('Most Agent-Hostile Areas');

  if (areas.length === 0) {
    console.log(`  ${chalk.green('✅')} No high-friction file hotspots detected`);
    console.log('');
    return;
  }

  areas.forEach((area) => {
    console.log(`  • ${formatPathForTerminal(repoRoot, area.filePath, { preferRelative: true })}`);
    console.log(`    ${chalk.dim(`Why: ${area.reasons.join('; ')}`)}`);
    console.log('');
  });
  await pause();
}

async function renderTaskFrictionWarnings(items: HealthItem[]): Promise<void> {
  renderSectionTitle('Task Friction Warnings');

  if (items.length === 0) {
    console.log(`  ${chalk.green('✅')} No major task-friction risks detected`);
    console.log('');
    return;
  }

  items.forEach((item, index) => {
    const label = item.status === 'fail' ? chalk.red('HIGH') : chalk.yellow('WARN');

    console.log(`  ${chalk.bold(`${index + 1}.`)} ${chalk.dim('[')}${label}${chalk.dim(']')}`);
    console.log(`     ${item.message}`);

    if (item.remediation) {
      console.log('');
      console.log(`     ${chalk.blueBright('What to do')}`);
      console.log(`     ${chalk.dim(item.remediation)}`);
    }

    console.log('');
  });
  await pause();
}

async function renderLargeFiles(
  repoRoot: string,
  files: string[],
  hugeFiles: string[],
  lineLimit: number,
): Promise<void> {
  renderSectionTitle('Largest Files');

  if (files.length === 0) {
    console.log(`  ${chalk.green('✅')} No files exceed ${lineLimit} lines`);
    console.log('');
    return;
  }

  files.slice(0, 5).forEach((file) => {
    const isHuge = hugeFiles.some((entry) => entry.startsWith(file.split(' (')[0] ?? ''));
    console.log(`  ${isHuge ? chalk.red('!') : chalk.dim('-')} ${formatFileEntry(repoRoot, file, { preferRelative: true })}`);
  });

  if (files.length > 5) {
    console.log(`  ${chalk.dim(`...and ${files.length - 5} more`)}`);
  }

  console.log('');
  await pause();
}

async function renderGenericFiles(repoRoot: string, files: string[]): Promise<void> {
  renderSectionTitle('Generic Modules');

  if (files.length === 0) {
    console.log(`  ${chalk.green('✅')} No generic filenames detected`);
    console.log('');
    return;
  }

  files.slice(0, 5).forEach((file) => {
    console.log(`  ${chalk.dim('-')} ${formatPathForTerminal(repoRoot, file, { preferRelative: true })}`);
  });

  if (files.length > 5) {
    console.log(`  ${chalk.dim(`...and ${files.length - 5} more`)}`);
  }

  console.log('');
  await pause();
}

async function renderHighCouplingFiles(repoRoot: string, files: string[]): Promise<void> {
  renderSectionTitle('High-Coupling Files');

  if (files.length === 0) {
    console.log(`  ${chalk.green('✅')} No import-heavy files detected`);
    console.log('');
    return;
  }

  files.slice(0, 5).forEach((file) => {
    console.log(`  ${chalk.dim('-')} ${formatFileEntry(repoRoot, file, { preferRelative: true })}`);
  });

  if (files.length > 5) {
    console.log(`  ${chalk.dim(`...and ${files.length - 5} more`)}`);
  }

  console.log('');
  await pause();
}

async function renderStructuralSignals(report: HealthCommandOutput['report']): Promise<void> {
  const architecture = report.sections.find((section) => section.title === 'Architectural Legibility');
  const documentation = report.sections.find((section) => section.title === 'Documentation Surface');
  const testing = report.sections.find((section) => section.title === 'Change Safety');
  const signals = [
    ...(architecture?.items.filter((item) => item.status !== 'pass') ?? []),
    ...(documentation?.items.filter((item) => item.status !== 'pass') ?? []),
    ...(testing?.items.filter((item) => item.status !== 'pass') ?? []),
  ]
    .slice(0, 6);

  renderSectionTitle('Structural Signals');

  if (signals.length === 0) {
    console.log(`  ${chalk.green('✅')} No major structural risks detected`);
    console.log('');
    return;
  }

  signals.forEach((item) => {
    const label = item.status === 'fail' ? chalk.red('HIGH') : chalk.yellow('WARN');
    console.log(`  ${chalk.dim('-')} ${chalk.dim('[')}${label}${chalk.dim(']')} ${item.message}`);
  });

  console.log('');
  await pause();
}

async function renderRecommendedFixes(items: string[]): Promise<void> {
  renderSectionTitle('Recommended Fixes');

  if (items.length === 0) {
    console.log(`  ${chalk.green('✅')} No remediation needed`);
    return;
  }

  items.forEach((item, index) => {
    console.log(`  ${chalk.bold(`${index + 1}.`)} ${item}`);
    console.log('');
  });
  await pause();
}

function renderFootnote(summary: { failures: number; warnings: number; passes: number }): void {
  console.log(
    chalk.dim(
      `Signals: ${summary.failures} fail, ${summary.warnings} warn, ${summary.passes} pass`,
    ),
  );
}

function dedupeItems(items: HealthItem[], field: 'message' | 'remediation' = 'message'): HealthItem[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const rawValue = field === 'message' ? item.message : item.remediation;

    if (!rawValue) {
      return false;
    }

    const key = rawValue.trim().toLowerCase();

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function buildTaskFrictionWarnings(report: HealthCommandOutput['report']): HealthItem[] {
  const warnings: HealthItem[] = [];
  const architectureItems = report.sections.find((section) => section.title === 'Architectural Legibility')?.items ?? [];
  const testingItems = report.sections.find((section) => section.title === 'Change Safety')?.items ?? [];
  const docsItems = report.sections.find((section) => section.title === 'Documentation Surface')?.items ?? [];
  const fileItems = report.sections.find((section) => section.title === 'Code Discoverability')?.items ?? [];
  const largeFiles = report.aiOperability.details.largeFilePaths;
  const hugeFiles = report.aiOperability.details.hugeFilePaths;
  const highCouplingFiles = report.aiOperability.details.highCouplingFiles;
  const genericFiles = report.aiOperability.details.genericFiles;
  const primaryHugeFile = hugeFiles[0] ?? largeFiles[0];
  const primaryCoupledFile = highCouplingFiles[0];

  if (testingItems.some((item) => item.message.includes('No test framework detected'))) {
    warnings.push({
      status: 'fail',
      message: 'Agents will be operating without safety rails when changing user flows because no test harness was detected.',
      remediation: 'Add Vitest or Jest and cover at least the highest-risk flows before relying on AI-assisted edits.',
      priority: 98,
    });
  }

  if (primaryCoupledFile) {
    const { filePath, count } = parseMetricEntry(primaryCoupledFile, 'imports');
    const surfaceArea = count ? `${count} imports` : 'many imports';
    const taskLabel = inferTaskLabel(filePath);

    warnings.push({
      status: 'warn',
      message: `Agents will struggle to safely modify ${taskLabel} because ${path.basename(filePath)} centralizes orchestration across ${surfaceArea}.`,
      remediation: `Extract orchestration from ${path.basename(filePath)} into smaller modules so changes stay localized.`,
      priority: 94,
    });
  }

  if (primaryHugeFile) {
    const { filePath, count } = parseMetricEntry(primaryHugeFile, 'lines');
    const sizeLabel = count ? `${count} lines` : 'a very large file';
    const taskLabel = inferRiskLabel(filePath);

    warnings.push({
      status: 'warn',
      message: `${taskLabel} may carry high regression risk because ${path.basename(filePath)} spans ${sizeLabel} with broad surface area.`,
      remediation: `Split ${path.basename(filePath)} by feature, workflow step, or data boundary before making more changes there.`,
      priority: count && count > 1000 ? 92 : 84,
    });
  }

  if (
    architectureItems.some((item) => item.message.includes('Business logic may be mixed'))
    || architectureItems.some((item) => item.message.includes('Service/domain boundary directories not found'))
  ) {
    warnings.push({
      status: 'warn',
      message: 'UI tasks are harder to scope because page, orchestration, and business logic appear mixed in the component layer.',
      remediation: 'Move fetching, orchestration, and domain logic into `lib/`, `services/`, `actions/`, or `db/` modules.',
      priority: 88,
    });
  }

  if (docsItems.some((item) => item.message.includes('No architecture documentation detected'))) {
    warnings.push({
      status: 'warn',
      message: 'Agents will spend extra turns reconstructing intent because there is no architecture doc for major flows and boundaries.',
      remediation: 'Add `docs/architecture.md` with key flows, module ownership, and where business logic is expected to live.',
      priority: 78,
    });
  }

  if (genericFiles.length > 0 || fileItems.some((item) => item.message.includes('Generic module filenames detected'))) {
    const fileList = genericFiles.slice(0, 2).map((file) => path.basename(file)).join(', ');

    warnings.push({
      status: 'warn',
      message: `Agents will need more repo-wide search to safely change shared behavior because generic modules like ${fileList || 'utils.ts'} hide intent.`,
      remediation: 'Rename broad utility files around the domain they serve and break unrelated helpers apart.',
      priority: 72,
    });
  }

  if (testingItems.some((item) => item.message.includes('No test files detected'))) {
    warnings.push({
      status: 'warn',
      message: 'Small UI or form edits may have hidden regression risk because there are no existing tests anchoring expected behavior.',
      remediation: 'Start with smoke tests around the highest-traffic screens and the flows most likely to change during interviews or demos.',
      priority: 90,
    });
  }

  return dedupeItems(warnings)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .slice(0, 5);
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

function inferTaskLabel(filePath: string): string {
  const normalizedPath = filePath.toLowerCase();

  if (normalizedPath.includes('/nav') || normalizedPath.includes('layout') || normalizedPath.includes('router')) {
    return 'navigation flow';
  }

  if (normalizedPath.includes('form') || normalizedPath.includes('claim') || normalizedPath.includes('checkout')) {
    return 'form flow';
  }

  if (normalizedPath.includes('/page') || normalizedPath.includes('/screen')) {
    return 'page-level behavior';
  }

  return 'changes in this area';
}

function inferRiskLabel(filePath: string): string {
  const normalizedPath = filePath.toLowerCase();

  if (normalizedPath.includes('form') || normalizedPath.includes('claim')) {
    return 'Form changes';
  }

  if (normalizedPath.includes('layout') || normalizedPath.includes('nav')) {
    return 'Navigation changes';
  }

  if (normalizedPath.includes('/page') || normalizedPath.includes('/screen')) {
    return 'Page-level changes';
  }

  return 'Changes in this area';
}

function getScoreLabel(score: number): { label: string; emoji: string; color: typeof chalk.green } {
  if (score >= 90) {
    return { label: 'Excellent', emoji: '🟢', color: chalk.greenBright };
  }

  if (score >= 75) {
    return { label: 'Good', emoji: '🟡', color: chalk.yellowBright };
  }

  if (score >= 55) {
    return { label: 'Needs work', emoji: '🟠', color: chalk.hex('#ff9f1c') };
  }

  return { label: 'High friction', emoji: '🔴', color: chalk.redBright };
}

function gradeSection(items: HealthItem[]): SectionGrade {
  if (items.length === 0) {
    return getLetterGrade(100);
  }

  const weightedScore = items.reduce((total, item) => {
    if (item.status === 'pass') {
      return total + 1;
    }

    if (item.status === 'warn') {
      return total + 0.55;
    }

    return total + 0.15;
  }, 0);
  const score = Math.round((weightedScore / items.length) * 100);

  return getLetterGrade(score);
}

function getLetterGrade(score: number): SectionGrade {
  if (score >= 97) {
    return { label: 'A+', score, color: chalk.greenBright };
  }

  if (score >= 93) {
    return { label: 'A', score, color: chalk.greenBright };
  }

  if (score >= 90) {
    return { label: 'A-', score, color: chalk.greenBright };
  }

  if (score >= 87) {
    return { label: 'B+', score, color: chalk.yellowBright };
  }

  if (score >= 83) {
    return { label: 'B', score, color: chalk.yellowBright };
  }

  if (score >= 80) {
    return { label: 'B-', score, color: chalk.yellowBright };
  }

  if (score >= 77) {
    return { label: 'C+', score, color: chalk.hex('#ffb347') };
  }

  if (score >= 73) {
    return { label: 'C', score, color: chalk.hex('#ffb347') };
  }

  if (score >= 70) {
    return { label: 'C-', score, color: chalk.hex('#ffb347') };
  }

  if (score >= 65) {
    return { label: 'D', score, color: chalk.hex('#ff9f1c') };
  }

  return { label: 'F', score, color: chalk.redBright };
}

function formatGradeBadge(grade: SectionGrade): string {
  return grade.color(`(${grade.label})`);
}

function formatFileEntry(
  repoRoot: string,
  entry: string,
  options: { preferRelative?: boolean } = {},
): string {
  const match = entry.match(/^(.*?)(\s+\(.+\))$/);

  if (!match) {
    return formatPathForTerminal(repoRoot, entry, options);
  }

  const [, relativePath, suffix] = match;
  return `${formatPathForTerminal(repoRoot, relativePath, options)}${chalk.dim(suffix)}`;
}

function formatPathForTerminal(
  repoRoot: string,
  relativePath: string,
  options: { preferRelative?: boolean } = {},
): string {
  const absolutePath = path.resolve(repoRoot, relativePath);
  const terminalPath = options.preferRelative ? relativePath : absolutePath;
  const displayPath = chalk.cyan(terminalPath);

  if (!process.stdout.isTTY) {
    return displayPath;
  }

  const href = `file://${encodeURI(absolutePath)}`;
  return `\u001B]8;;${href}\u0007${displayPath}\u001B]8;;\u0007`;
}

function renderMeter(score: number): string {
  const total = 20;
  const filled = Math.round((score / 100) * total);
  const color = getScoreColor(score);
  return `${color('█'.repeat(filled))}${chalk.dim('░'.repeat(total - filled))}`;
}

function renderMiniMeter(score: number): string {
  const total = 10;
  const filled = Math.round((score / 100) * total);
  return `${'■'.repeat(filled)}${'·'.repeat(total - filled)}`;
}

function getScoreColor(score: number): typeof chalk.green {
  if (score >= 90) {
    return chalk.greenBright;
  }

  if (score >= 75) {
    return chalk.yellowBright;
  }

  if (score >= 55) {
    return chalk.hex('#ff9f1c');
  }

  return chalk.redBright;
}

function getStatusEmoji(status: HealthItem['status']): string {
  if (status === 'fail') {
    return '⛔';
  }

  if (status === 'warn') {
    return '⚠️';
  }

  return '✅';
}

async function pause(): Promise<void> {
  if (!process.stdout.isTTY) {
    return;
  }

  await delay(35);
}

function renderSectionTitle(title: string): void {
  console.log(chalk.bold(title));
  console.log(chalk.dim(`  ${'-'.repeat(Math.max(18, title.length + 2))}`));
}
