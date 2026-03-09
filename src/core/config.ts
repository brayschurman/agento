import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlanioConfig } from '../types/config.js';

export const APP_CONFIG_FILENAME = 'agento.json';
const LEGACY_CONFIG_FILENAMES = ['planio.json'];

export const DEFAULT_PLANIO_CONFIG: PlanioConfig = {
  $schema: 'https://agento.dev/schema/agento.json',
  rules: {
    comments: {
      exportedFunctions: 'off',
    },
    files: {
      maxLines: 500,
      genericNames: 'warn',
    },
    docs: {
      requireReadme: true,
      requirePlanioMd: false,
      requireArchitectureDoc: true,
    },
    architecture: {
      requiredDirs: [],
      bannedImports: [],
    },
  },
};

export function getPlanioConfigPath(baseDirectory: string): string {
  return path.join(baseDirectory, APP_CONFIG_FILENAME);
}

export async function planioConfigExists(baseDirectory: string): Promise<boolean> {
  try {
    await access(getPlanioConfigPath(baseDirectory));
    return true;
  } catch {
    for (const filename of LEGACY_CONFIG_FILENAMES) {
      try {
        await access(path.join(baseDirectory, filename));
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }
}

export async function writePlanioConfig(
  baseDirectory: string,
  config: PlanioConfig = DEFAULT_PLANIO_CONFIG,
): Promise<string> {
  const configPath = getPlanioConfigPath(baseDirectory);
  const contents = `${JSON.stringify(config, null, 2)}\n`;

  await writeFile(configPath, contents, 'utf8');

  return configPath;
}

export async function loadPlanioConfig(baseDirectory: string): Promise<PlanioConfig> {
  const configPaths = [
    getPlanioConfigPath(baseDirectory),
    ...LEGACY_CONFIG_FILENAMES.map((filename) => path.join(baseDirectory, filename)),
  ];

  for (const configPath of configPaths) {
    try {
      const rawConfig = await readFile(configPath, 'utf8');
      const parsedConfig = JSON.parse(rawConfig) as Partial<PlanioConfig>;

      return {
        ...DEFAULT_PLANIO_CONFIG,
        ...parsedConfig,
        rules: {
          ...DEFAULT_PLANIO_CONFIG.rules,
          ...parsedConfig.rules,
          comments: {
            ...DEFAULT_PLANIO_CONFIG.rules.comments,
            ...parsedConfig.rules?.comments,
          },
          files: {
            ...DEFAULT_PLANIO_CONFIG.rules.files,
            ...parsedConfig.rules?.files,
          },
          docs: {
            ...DEFAULT_PLANIO_CONFIG.rules.docs,
            ...parsedConfig.rules?.docs,
          },
          architecture: {
            ...DEFAULT_PLANIO_CONFIG.rules.architecture,
            ...parsedConfig.rules?.architecture,
            requiredDirs: parsedConfig.rules?.architecture?.requiredDirs ?? DEFAULT_PLANIO_CONFIG.rules.architecture.requiredDirs,
            bannedImports: parsedConfig.rules?.architecture?.bannedImports ?? DEFAULT_PLANIO_CONFIG.rules.architecture.bannedImports,
          },
        },
      };
    } catch {
      continue;
    }
  }

  return DEFAULT_PLANIO_CONFIG;
}
