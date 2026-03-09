export interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface RepoMarkers {
  hasGit: boolean;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun' | null;
  hasReadme: boolean;
  hasDocsDirectory: boolean;
  hasArchitectureDoc: boolean;
  hasContributingDoc: boolean;
  hasPlanioMd: boolean;
}

export interface RepoContext {
  repoRoot: string;
  markers: RepoMarkers;
  packageManifest: PackageManifest | null;
  directories: string[];
  files: string[];
}

export interface HealthItem {
  status: 'pass' | 'warn' | 'fail';
  message: string;
  remediation?: string;
  priority?: number;
  evidence?: HealthEvidenceGroup[];
}

export interface HealthEvidenceGroup {
  label: string;
  entries: string[];
}

export interface HealthSection {
  title: string;
  items: HealthItem[];
  summary?: string;
}

export interface HealthSummary {
  failures: number;
  warnings: number;
  passes: number;
}

export interface AiOperabilitySubscore {
  key:
    | 'codeDiscoverability'
    | 'contextDensity'
    | 'architecturalLegibility'
    | 'blastRadius'
    | 'changeSafety'
    | 'agentTaskability'
    | 'documentationSurface';
  label: string;
  score: number;
  weight: number;
}

export interface AgentHostileArea {
  filePath: string;
  reasons: string[];
  score: number;
}

export interface AiOperabilityReport {
  score: number;
  warnings: HealthItem[];
  subscores: AiOperabilitySubscore[];
  details: {
    largeFilesOverLimit: number;
    largeFileLimit: number;
    largeFilesOver1000: number;
    largeFilePaths: string[];
    hugeFilePaths: string[];
    genericFiles: string[];
    genericFileCount: number;
    architectureSignalCount: number;
    dependencyCount: number;
    highCouplingFiles: string[];
    agentHostileAreas: AgentHostileArea[];
  };
}

export interface HealthReport {
  repoRoot: string;
  projectLabel: string;
  sections: HealthSection[];
  aiOperability: AiOperabilityReport;
}

export interface HealthCommandOutput {
  summary: HealthSummary;
  taskFrictionWarnings: HealthItem[];
  topIssues: HealthItem[];
  recommendedFixes: string[];
  report: HealthReport;
}
