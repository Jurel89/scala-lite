import * as vscode from 'vscode';
import { WorkspaceMode } from './modePresentation';
import { ScalaLiteLogLevel } from './structuredLogCore';
import { BuildTool } from './buildToolInference';
import { TaskProfile } from './profileCore';

export const WORKSPACE_CONFIG_RELATIVE_PATH = '.vscode/scala-lite.json';

export const WORKSPACE_CONFIG_TOP_LEVEL_KEYS = [
  'mode',
  'moduleFolder',
  'indexedModuleFolder',
  'profiles',
  'activeProfile',
  'ignorePatterns',
  'unsafeMode',
  'budgets',
  'diagnostics',
  'formatter',
  'linter',
  'logLevel',
  'testFrameworkHints'
] as const;

type _WorkspaceConfigTopLevelKey = (typeof WORKSPACE_CONFIG_TOP_LEVEL_KEYS)[number];

export interface BudgetConfig {
  readonly searchTimeMs?: number;
  readonly indexTimeMs?: number;
  readonly maxSearchResults?: number;
  readonly formatterTimeMs?: number;
}

export interface EffectiveBudgetConfig {
  readonly searchTimeMs: number;
  readonly indexTimeMs: number;
  readonly maxSearchResults: number;
  readonly formatterTimeMs: number;
}

export interface DiagnosticsConfig {
  readonly enabled?: boolean;
  readonly trigger?: 'onSave' | 'onType';
}

export interface EffectiveDiagnosticsConfig {
  readonly enabled: boolean;
  readonly trigger: 'onSave' | 'onType';
}

export interface FormatterConfig {
  readonly path?: string;
  readonly scalafmtPath?: string;
  readonly useDocker?: boolean;
  readonly timeoutMs?: number;
  readonly formatOnSave?: boolean;
}

export interface LinterConfig {
  readonly path?: string;
  readonly scalafixPath?: string;
  readonly useDocker?: boolean;
  readonly timeoutMs?: number;
}

interface ScalaLiteWorkspaceConfig {
  readonly mode?: WorkspaceMode | {
    readonly default?: WorkspaceMode;
  };
  readonly moduleFolder?: string;
  readonly indexedModuleFolder?: string;
  readonly profiles?: TaskProfile[];
  readonly activeProfile?: string;
  readonly logLevel?: ScalaLiteLogLevel;
  readonly ignorePatterns?: readonly string[];
  readonly unsafeMode?: boolean;
  readonly budgets?: BudgetConfig;
  readonly diagnostics?: DiagnosticsConfig;
  readonly formatter?: FormatterConfig;
  readonly linter?: LinterConfig;
  readonly testFrameworkHints?: readonly string[];
  readonly [key: string]: unknown;
}

const invalidJsonWarnings = new Set<string>();

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function getWorkspaceConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, WORKSPACE_CONFIG_RELATIVE_PATH);
}

async function readConfig(folder: vscode.WorkspaceFolder): Promise<ScalaLiteWorkspaceConfig> {
  const configUri = getWorkspaceConfigUri(folder);

  try {
    const raw = await vscode.workspace.fs.readFile(configUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ScalaLiteWorkspaceConfig;
    invalidJsonWarnings.delete(configUri.toString());
    return parsed;
  } catch (error) {
    const key = configUri.toString();
    if (!invalidJsonWarnings.has(key)) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('JSON')) {
        invalidJsonWarnings.add(key);
        void vscode.window.showWarningMessage(vscode.l10n.t('Configuration file is invalid JSON. Defaults are being used until fixed.'));
      }
    }

    return {};
  }
}

async function writeConfig(folder: vscode.WorkspaceFolder, config: ScalaLiteWorkspaceConfig): Promise<void> {
  const configUri = getWorkspaceConfigUri(folder);
  const parent = vscode.Uri.joinPath(folder.uri, '.vscode');
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(configUri, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
}

function createDefaultProfile(buildTool: BuildTool = 'sbt'): TaskProfile {
  const normalizedBuildTool: BuildTool = buildTool === 'none' ? 'sbt' : buildTool;

  return {
    name: `Default (${normalizedBuildTool})`,
    buildTool: normalizedBuildTool,
    workingDirectory: '.',
    runCommand: normalizedBuildTool === 'scala-cli'
      ? 'scala-cli run "{{filePath}}"'
      : normalizedBuildTool === 'mill'
        ? 'mill __.runMain {{mainClass}}'
        : 'sbt "runMain {{mainClass}}"',
    testCommand: normalizedBuildTool === 'scala-cli'
      ? 'scala-cli test "{{filePath}}"'
      : normalizedBuildTool === 'mill'
        ? 'mill __.testOnly {{suiteName}}'
        : 'sbt "testOnly {{suiteName}}"',
    envVars: {},
    jvmOpts: [],
    preBuildCommand: ''
  };
}

export function buildDefaultWorkspaceConfig(buildTool: BuildTool = 'sbt'): ScalaLiteWorkspaceConfig {
  return {
    mode: 'A',
    moduleFolder: '',
    profiles: [createDefaultProfile(buildTool)],
    activeProfile: `Default (${buildTool === 'none' ? 'sbt' : buildTool})`,
    ignorePatterns: [],
    unsafeMode: false,
    budgets: {
      searchTimeMs: 2000,
      indexTimeMs: 5000,
      maxSearchResults: 500,
      formatterTimeMs: 5000
    },
    diagnostics: {
      enabled: true,
      trigger: 'onSave'
    },
    formatter: {
      scalafmtPath: '',
      useDocker: false,
      timeoutMs: 5000,
      formatOnSave: false
    },
    linter: {
      scalafixPath: '',
      useDocker: false,
      timeoutMs: 10000
    },
    logLevel: 'INFO',
    testFrameworkHints: []
  };
}

export function isWorkspaceConfigDocument(document: vscode.TextDocument): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return false;
  }

  return document.uri.toString() === getWorkspaceConfigUri(folder).toString();
}

export function getUnknownTopLevelWorkspaceConfigKeys(config: Record<string, unknown>): string[] {
  const allowed = new Set<string>(WORKSPACE_CONFIG_TOP_LEVEL_KEYS);
  return Object.keys(config).filter((key) => !allowed.has(key));
}

export async function getPrimaryWorkspaceConfigUri(): Promise<vscode.Uri | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  return getWorkspaceConfigUri(folder);
}

export async function openOrCreateWorkspaceConfig(buildTool: BuildTool = 'sbt'): Promise<vscode.TextDocument | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  const configUri = getWorkspaceConfigUri(folder);

  try {
    return await vscode.workspace.openTextDocument(configUri);
  } catch {
    await writeConfig(folder, buildDefaultWorkspaceConfig(buildTool));
    return vscode.workspace.openTextDocument(configUri);
  }
}

export async function readWorkspaceConfigRaw(): Promise<Record<string, unknown>> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {};
  }

  const config = await readConfig(folder);
  return config as Record<string, unknown>;
}

export async function readDefaultModeFromWorkspaceConfig(): Promise<WorkspaceMode | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  const config = await readConfig(folder);
  if (config.mode === 'A' || config.mode === 'B' || config.mode === 'C') {
    return config.mode;
  }

  return config.mode?.default;
}

export async function writeIndexedModuleFolderToWorkspaceConfig(relativePath: string): Promise<void> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return;
  }

  const existing = await readConfig(folder);
  await writeConfig(folder, {
    ...existing,
    moduleFolder: relativePath,
    indexedModuleFolder: relativePath
  });
}

export async function readModuleFolderFromWorkspaceConfig(): Promise<string | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  const config = await readConfig(folder);
  const configured = typeof config.moduleFolder === 'string' && config.moduleFolder.trim().length > 0
    ? config.moduleFolder
    : config.indexedModuleFolder;

  if (typeof configured !== 'string' || configured.trim().length === 0) {
    return undefined;
  }

  return configured;
}

export async function readLogLevelFromWorkspaceConfig(): Promise<ScalaLiteLogLevel | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  const config = await readConfig(folder);
  return config.logLevel;
}

export async function readFormatterConfigFromWorkspaceConfig(): Promise<FormatterConfig> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {};
  }

  const config = await readConfig(folder);
  const formatter = config.formatter ?? {};
  return {
    ...formatter,
    path: formatter.path ?? formatter.scalafmtPath
  };
}

export async function readDiagnosticsConfigFromWorkspaceConfig(): Promise<EffectiveDiagnosticsConfig> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      enabled: true,
      trigger: 'onSave'
    };
  }

  const config = await readConfig(folder);
  const diagnostics = config.diagnostics ?? {};

  return {
    enabled: diagnostics.enabled ?? true,
    trigger: diagnostics.trigger ?? 'onSave'
  };
}

export async function readBudgetConfigFromWorkspaceConfig(): Promise<EffectiveBudgetConfig> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      searchTimeMs: 2000,
      indexTimeMs: 5000,
      maxSearchResults: 500,
      formatterTimeMs: 5000
    };
  }

  const config = await readConfig(folder);
  const budgets = config.budgets ?? {};

  const searchTimeMs = typeof budgets.searchTimeMs === 'number' && budgets.searchTimeMs > 0
    ? Math.round(budgets.searchTimeMs)
    : 2000;
  const indexTimeMs = typeof budgets.indexTimeMs === 'number' && budgets.indexTimeMs > 0
    ? Math.round(budgets.indexTimeMs)
    : 5000;
  const maxSearchResults = typeof budgets.maxSearchResults === 'number' && budgets.maxSearchResults > 0
    ? Math.round(budgets.maxSearchResults)
    : 500;
  const formatterTimeMs = typeof budgets.formatterTimeMs === 'number' && budgets.formatterTimeMs > 0
    ? Math.round(budgets.formatterTimeMs)
    : 5000;

  return {
    searchTimeMs,
    indexTimeMs,
    maxSearchResults,
    formatterTimeMs
  };
}

export async function readLinterConfigFromWorkspaceConfig(): Promise<LinterConfig> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {};
  }

  const config = await readConfig(folder);
  const linter = config.linter ?? {};
  return {
    ...linter,
    path: linter.path ?? linter.scalafixPath
  };
}

export interface IgnoreRulesWorkspaceConfig {
  readonly ignorePatterns: readonly string[];
  readonly unsafeMode: boolean;
}

export async function readIgnoreRulesFromWorkspaceConfig(): Promise<IgnoreRulesWorkspaceConfig> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      ignorePatterns: [],
      unsafeMode: false
    };
  }

  const config = await readConfig(folder);
  return {
    ignorePatterns: Array.isArray(config.ignorePatterns)
      ? config.ignorePatterns.filter((value): value is string => typeof value === 'string')
      : [],
    unsafeMode: config.unsafeMode === true
  };
}