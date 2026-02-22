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
  'workspaceDoctor',
  'logLevel',
  'testFrameworkHints'
] as const;

type _WorkspaceConfigTopLevelKey = (typeof WORKSPACE_CONFIG_TOP_LEVEL_KEYS)[number];

export interface BudgetConfig {
  readonly searchTimeMs?: number;
  readonly indexTimeMs?: number;
  readonly maxSearchResults?: number;
  readonly formatterTimeMs?: number;
  readonly indexBatchSize?: number;
  readonly memory?: MemoryBudgetOverrideConfig;
}

export interface MemoryBudgetOverrideConfig {
  readonly heapMb?: number;
  readonly nativeMb?: number;
  readonly totalMb?: number;
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

export interface WorkspaceDoctorConfig {
  readonly autoRunOnOpen?: boolean;
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
  readonly workspaceDoctor?: WorkspaceDoctorConfig;
  readonly testFrameworkHints?: readonly string[];
  readonly [key: string]: unknown;
}

interface EffectiveSettingsConfig {
  readonly mode?: WorkspaceMode;
  readonly logLevel?: ScalaLiteLogLevel;
  readonly diagnosticsEnabled?: boolean;
  readonly diagnosticsTrigger?: 'onSave' | 'onType';
  readonly formatterFormatOnSave?: boolean;
}

type SupportedSettingKey =
  | 'mode'
  | 'logLevel'
  | 'diagnostics.enabled'
  | 'diagnostics.trigger'
  | 'formatter.formatOnSave'
  | 'activeProfile';

interface SettingsCustomizationState {
  readonly hasCustomizedSettings: boolean;
  readonly customizedKeys: ReadonlySet<SupportedSettingKey>;
}

export type WorkspaceConfigSource = 'defaults' | 'settings-ui' | 'json-file' | 'merged';

export interface WorkspaceConfigSourceState {
  readonly source: WorkspaceConfigSource;
  readonly hasSettingsUiValues: boolean;
  readonly hasJsonFile: boolean;
  readonly hasOverlappingOverrides: boolean;
}

let currentWorkspaceConfigSourceState: WorkspaceConfigSourceState = {
  source: 'defaults',
  hasSettingsUiValues: false,
  hasJsonFile: false,
  hasOverlappingOverrides: false
};

const invalidJsonWarnings = new Set<string>();

function getSettingsCustomizationState(): SettingsCustomizationState {
  const settings = vscode.workspace.getConfiguration('scalaLite');
  const keys: SupportedSettingKey[] = [
    'mode',
    'logLevel',
    'diagnostics.enabled',
    'diagnostics.trigger',
    'formatter.formatOnSave',
    'activeProfile'
  ];

  const customizedKeys = new Set<SupportedSettingKey>();
  for (const key of keys) {
    const inspected = settings.inspect(key);
    if (
      inspected?.workspaceFolderValue !== undefined
      || inspected?.workspaceValue !== undefined
      || inspected?.globalValue !== undefined
    ) {
      customizedKeys.add(key);
    }
  }

  return {
    hasCustomizedSettings: customizedKeys.size > 0,
    customizedKeys
  };
}

async function readConfigWithMetadata(folder: vscode.WorkspaceFolder): Promise<{
  readonly config: ScalaLiteWorkspaceConfig;
  readonly exists: boolean;
}> {
  const configUri = getWorkspaceConfigUri(folder);

  try {
    await vscode.workspace.fs.stat(configUri);
  } catch {
    invalidJsonWarnings.delete(configUri.toString());
    return {
      config: {},
      exists: false
    };
  }

  try {
    const raw = await vscode.workspace.fs.readFile(configUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ScalaLiteWorkspaceConfig;
    invalidJsonWarnings.delete(configUri.toString());
    return {
      config: parsed,
      exists: true
    };
  } catch (error) {
    const key = configUri.toString();
    if (!invalidJsonWarnings.has(key)) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('JSON')) {
        invalidJsonWarnings.add(key);
        void vscode.window.showWarningMessage(vscode.l10n.t('Configuration file is invalid JSON. Defaults are being used until fixed.'));
      }
    }

    return {
      config: {},
      exists: true
    };
  }
}

function hasOverlappingSettingsOverrides(
  config: ScalaLiteWorkspaceConfig,
  customizedKeys: ReadonlySet<SupportedSettingKey>
): boolean {
  const diagnostics = config.diagnostics ?? {};
  const formatter = config.formatter ?? {};

  return (
    (customizedKeys.has('mode') && (config.mode === 'A' || config.mode === 'B' || config.mode === 'C'))
    || (customizedKeys.has('logLevel') && typeof config.logLevel === 'string')
    || (customizedKeys.has('diagnostics.enabled') && typeof diagnostics.enabled === 'boolean')
    || (customizedKeys.has('diagnostics.trigger') && (diagnostics.trigger === 'onSave' || diagnostics.trigger === 'onType'))
    || (customizedKeys.has('formatter.formatOnSave') && typeof formatter.formatOnSave === 'boolean')
    || (customizedKeys.has('activeProfile') && typeof config.activeProfile === 'string')
  );
}

export function getWorkspaceConfigSourceState(): WorkspaceConfigSourceState {
  return currentWorkspaceConfigSourceState;
}

export function getWorkspaceConfigSourceLabel(): string {
  const source = currentWorkspaceConfigSourceState.source;

  if (source === 'settings-ui') {
    return vscode.l10n.t('settings UI');
  }

  if (source === 'json-file') {
    return vscode.l10n.t('scala-lite.json');
  }

  if (source === 'merged') {
    return vscode.l10n.t('scala-lite.json + settings UI (file wins)');
  }

  return vscode.l10n.t('defaults');
}

export async function refreshWorkspaceConfigSourceState(): Promise<WorkspaceConfigSourceState> {
  const settingsState = getSettingsCustomizationState();
  const folder = getPrimaryWorkspaceFolder();

  if (!folder) {
    currentWorkspaceConfigSourceState = {
      source: settingsState.hasCustomizedSettings ? 'settings-ui' : 'defaults',
      hasSettingsUiValues: settingsState.hasCustomizedSettings,
      hasJsonFile: false,
      hasOverlappingOverrides: false
    };
    return currentWorkspaceConfigSourceState;
  }

  const { config, exists } = await readConfigWithMetadata(folder);

  const source: WorkspaceConfigSource = exists
    ? (settingsState.hasCustomizedSettings ? 'merged' : 'json-file')
    : (settingsState.hasCustomizedSettings ? 'settings-ui' : 'defaults');

  const hasOverlappingOverrides = exists
    && settingsState.hasCustomizedSettings
    && hasOverlappingSettingsOverrides(config, settingsState.customizedKeys);

  currentWorkspaceConfigSourceState = {
    source,
    hasSettingsUiValues: settingsState.hasCustomizedSettings,
    hasJsonFile: exists,
    hasOverlappingOverrides
  };

  return currentWorkspaceConfigSourceState;
}

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function getWorkspaceConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, WORKSPACE_CONFIG_RELATIVE_PATH);
}

function readSettingsConfig(): EffectiveSettingsConfig {
  const settings = vscode.workspace.getConfiguration('scalaLite');
  const mode = settings.get<string>('mode');
  const logLevel = settings.get<string>('logLevel');
  const diagnosticsTrigger = settings.get<string>('diagnostics.trigger');

  return {
    mode: mode === 'A' || mode === 'B' || mode === 'C' ? mode : undefined,
    logLevel: logLevel === 'DEBUG' || logLevel === 'INFO' || logLevel === 'WARN' || logLevel === 'ERROR'
      ? logLevel
      : undefined,
    diagnosticsEnabled: settings.get<boolean>('diagnostics.enabled'),
    diagnosticsTrigger: diagnosticsTrigger === 'onSave' || diagnosticsTrigger === 'onType'
      ? diagnosticsTrigger
      : undefined,
    formatterFormatOnSave: settings.get<boolean>('formatter.formatOnSave')
  };
}

async function readConfig(folder: vscode.WorkspaceFolder): Promise<ScalaLiteWorkspaceConfig> {
  const metadata = await readConfigWithMetadata(folder);
  return metadata.config;
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
    mode: 'C',
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
    workspaceDoctor: {
      autoRunOnOpen: false
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

export async function createOrOverwriteWorkspaceConfig(
  buildTool: BuildTool = 'sbt',
  overwrite = false
): Promise<{ readonly uri?: vscode.Uri; readonly exists: boolean; readonly written: boolean }> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      exists: false,
      written: false
    };
  }

  const configUri = getWorkspaceConfigUri(folder);
  let exists: boolean;
  try {
    await vscode.workspace.fs.stat(configUri);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists && !overwrite) {
    return {
      uri: configUri,
      exists,
      written: false
    };
  }

  await writeConfig(folder, buildDefaultWorkspaceConfig(buildTool));
  return {
    uri: configUri,
    exists,
    written: true
  };
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
  const settings = readSettingsConfig();
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return settings.mode;
  }

  const config = await readConfig(folder);
  if (config.mode === 'A' || config.mode === 'B' || config.mode === 'C') {
    return config.mode;
  }

  return config.mode?.default ?? settings.mode;
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
  const settings = readSettingsConfig();
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return settings.logLevel;
  }

  const config = await readConfig(folder);
  return config.logLevel ?? settings.logLevel;
}

export async function readFormatterConfigFromWorkspaceConfig(): Promise<FormatterConfig> {
  const settings = readSettingsConfig();
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      formatOnSave: settings.formatterFormatOnSave
    };
  }

  const config = await readConfig(folder);
  const formatter = config.formatter ?? {};
  return {
    ...formatter,
    path: formatter.path ?? formatter.scalafmtPath,
    formatOnSave: formatter.formatOnSave ?? settings.formatterFormatOnSave
  };
}

export async function readDiagnosticsConfigFromWorkspaceConfig(): Promise<EffectiveDiagnosticsConfig> {
  const settings = readSettingsConfig();
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      enabled: typeof settings.diagnosticsEnabled === 'boolean'
        ? settings.diagnosticsEnabled
        : true,
      trigger: settings.diagnosticsTrigger ?? 'onSave'
    };
  }

  const config = await readConfig(folder);
  const diagnostics = config.diagnostics ?? {};
  const enabled = typeof diagnostics.enabled === 'boolean'
    ? diagnostics.enabled
    : (typeof settings.diagnosticsEnabled === 'boolean' ? settings.diagnosticsEnabled : true);
  const trigger = diagnostics.trigger === 'onType' || diagnostics.trigger === 'onSave'
    ? diagnostics.trigger
    : (settings.diagnosticsTrigger ?? 'onSave');

  return {
    enabled,
    trigger
  };
}

export async function readWorkspaceDoctorConfigFromWorkspaceConfig(): Promise<Required<WorkspaceDoctorConfig>> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {
      autoRunOnOpen: false
    };
  }

  const config = await readConfig(folder);
  const workspaceDoctor = config.workspaceDoctor ?? {};
  return {
    autoRunOnOpen: workspaceDoctor.autoRunOnOpen === true
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

export async function readIndexBatchSizeFromWorkspaceConfig(): Promise<number> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return 100;
  }

  const config = await readConfig(folder);
  const value = config.budgets?.indexBatchSize;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 100;
  }

  return Math.min(1000, Math.max(1, Math.round(value)));
}

export async function readMemoryBudgetOverridesFromWorkspaceConfig(): Promise<MemoryBudgetOverrideConfig> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return {};
  }

  const config = await readConfig(folder);
  const memory = config.budgets?.memory;

  const normalizeMb = (value: number | undefined): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }

    return Math.round(value);
  };

  return {
    heapMb: normalizeMb(memory?.heapMb),
    nativeMb: normalizeMb(memory?.nativeMb),
    totalMb: normalizeMb(memory?.totalMb)
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