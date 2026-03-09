export type RuleSeverity = 'off' | 'warn' | 'error';

export interface PlanioConfig {
  $schema?: string;
  rules: {
    comments: {
      exportedFunctions: RuleSeverity;
    };
    files: {
      maxLines: number;
      genericNames: RuleSeverity;
    };
    docs: {
      requireReadme: boolean;
      requirePlanioMd: boolean;
      requireArchitectureDoc: boolean;
    };
    architecture: {
      requiredDirs: string[];
      bannedImports: Array<{
        from: string;
        to: string;
      }>;
    };
  };
}
