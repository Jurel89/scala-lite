import * as vscode from 'vscode';
import { ClasspathProvider, detectClasspathProvider } from './buildToolDetector';
import { JdkResolutionResult, resolveJdkModules } from './jdkResolver';
import { MavenModule, discoverMavenModules, resolveMavenClasspath } from './mavenProvider';
import { resolveSbtClasspath } from './sbtProvider';
import { ensureScalaLiteCacheDir, getScalaLiteCacheUri } from './scalaLiteCache';
import { EffectiveBuildConfig, EffectiveDependencyConfig } from './workspaceConfig';

const SYNC_STATUS_FILE = 'dependency-sync-status.json';
const JDK_STATE_FILE = 'jdk-modules.json';

export interface DependencySyncStatus {
  readonly lastRunAt: string;
  readonly provider: ClasspathProvider;
  readonly modulePath?: string;
  readonly moduleArtifactId?: string;
  readonly jarsCount: number;
  readonly outputDirCount: number;
  readonly jdkHome?: string;
  readonly jdkSource?: string;
  readonly selectedJdkModuleCount: number;
  readonly availableJdkModuleCount: number;
  readonly cacheFilePath?: string;
  readonly durationMs: number;
  readonly success: boolean;
  readonly errorMessage?: string;
}

export interface SyncMavenClasspathOptions {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly module: MavenModule;
  readonly buildConfig: EffectiveBuildConfig;
  readonly dependencyConfig: EffectiveDependencyConfig;
  readonly cancellationToken: vscode.CancellationToken;
  readonly onOutput?: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface SyncSbtClasspathOptions {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly buildConfig: EffectiveBuildConfig;
  readonly dependencyConfig: EffectiveDependencyConfig;
  readonly cancellationToken: vscode.CancellationToken;
  readonly onOutput?: (line: string) => void;
  readonly timeoutMs?: number;
}

export interface PreparedClasspathSync {
  readonly provider: ClasspathProvider;
  readonly modules: readonly MavenModule[];
}

async function writeCacheJson(
  workspaceFolder: vscode.WorkspaceFolder,
  fileName: string,
  payload: unknown
): Promise<string | undefined> {
  const cacheRoot = await ensureScalaLiteCacheDir(workspaceFolder);
  if (!cacheRoot) {
    return undefined;
  }

  const target = vscode.Uri.joinPath(cacheRoot, fileName);
  await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
  return target.fsPath;
}

export async function prepareClasspathSync(
  workspaceFolder: vscode.WorkspaceFolder,
  buildConfig: EffectiveBuildConfig,
  promptUser?: (providers: readonly ClasspathProvider[]) => Promise<ClasspathProvider | undefined>
): Promise<PreparedClasspathSync> {
  const providerResult = await detectClasspathProvider(
    workspaceFolder,
    {
      preferred: buildConfig.classpathProvider,
      promptUser
    }
  );

  if (providerResult.provider !== 'maven') {
    return {
      provider: providerResult.provider,
      modules: []
    };
  }

  const modules = await discoverMavenModules(workspaceFolder);
  return {
    provider: providerResult.provider,
    modules
  };
}

export async function syncMavenClasspathWithJdk(
  options: SyncMavenClasspathOptions
): Promise<DependencySyncStatus> {
  const startedAt = Date.now();

  const [classpathSettled, jdkSettled] = await Promise.allSettled([
    resolveMavenClasspath({
      workspaceFolder: options.workspaceFolder,
      module: options.module,
      includeTestScope: options.dependencyConfig.indexTestScope,
      profiles: options.buildConfig.mavenProfiles,
      extraArgs: options.buildConfig.mavenArgs,
      wrapperPathOverride: options.buildConfig.mavenWrapperPath,
      timeoutMs: options.timeoutMs ?? 120_000,
      cancellationToken: options.cancellationToken,
      onOutput: options.onOutput
    }),
    resolveJdkModules(
      options.workspaceFolder,
      options.buildConfig.jdkHome,
      options.dependencyConfig.jdkModules
    )
  ]);

  if (classpathSettled.status === 'rejected') {
    throw classpathSettled.reason instanceof Error
      ? classpathSettled.reason
      : new Error(String(classpathSettled.reason));
  }

  const classpathResult = classpathSettled.value;
  const jdkResult: JdkResolutionResult = jdkSettled.status === 'fulfilled'
    ? jdkSettled.value
    : { source: 'none' as const, availableModules: [], selectedModules: [] };

  await writeCacheJson(options.workspaceFolder, JDK_STATE_FILE, {
    version: 1,
    detectedAt: new Date().toISOString(),
    source: jdkResult.source,
    home: jdkResult.home,
    jmodsPath: jdkResult.jmodsPath,
    rtJarPath: jdkResult.rtJarPath,
    selectedModules: jdkResult.selectedModules,
    availableModules: jdkResult.availableModules
  });

  const status: DependencySyncStatus = {
    lastRunAt: new Date().toISOString(),
    provider: 'maven',
    modulePath: classpathResult.module.path,
    moduleArtifactId: classpathResult.module.artifactId,
    jarsCount: classpathResult.jars.length,
    outputDirCount: classpathResult.outputDirs.length,
    jdkHome: jdkResult.home,
    jdkSource: jdkResult.source,
    selectedJdkModuleCount: jdkResult.selectedModules.length,
    availableJdkModuleCount: jdkResult.availableModules.length,
    cacheFilePath: classpathResult.cacheFilePath,
    durationMs: Date.now() - startedAt,
    success: true
  };

  await writeCacheJson(options.workspaceFolder, SYNC_STATUS_FILE, status);
  return status;
}

export async function syncSbtClasspathWithJdk(
  options: SyncSbtClasspathOptions
): Promise<DependencySyncStatus> {
  const startedAt = Date.now();

  const [classpathSettled, jdkSettled] = await Promise.allSettled([
    resolveSbtClasspath({
      workspaceFolder: options.workspaceFolder,
      includeTestScope: options.dependencyConfig.indexTestScope,
      strategy: options.buildConfig.sbtStrategy,
      extraArgs: options.buildConfig.sbtArgs,
      timeoutMs: options.timeoutMs ?? 120_000,
      cancellationToken: options.cancellationToken,
      onOutput: options.onOutput
    }),
    resolveJdkModules(
      options.workspaceFolder,
      options.buildConfig.jdkHome,
      options.dependencyConfig.jdkModules
    )
  ]);

  if (classpathSettled.status === 'rejected') {
    throw classpathSettled.reason instanceof Error
      ? classpathSettled.reason
      : new Error(String(classpathSettled.reason));
  }

  const classpathResult = classpathSettled.value;
  const jdkResult: JdkResolutionResult = jdkSettled.status === 'fulfilled'
    ? jdkSettled.value
    : { source: 'none' as const, availableModules: [], selectedModules: [] };

  await writeCacheJson(options.workspaceFolder, JDK_STATE_FILE, {
    version: 1,
    detectedAt: new Date().toISOString(),
    source: jdkResult.source,
    home: jdkResult.home,
    jmodsPath: jdkResult.jmodsPath,
    rtJarPath: jdkResult.rtJarPath,
    selectedModules: jdkResult.selectedModules,
    availableModules: jdkResult.availableModules
  });

  const status: DependencySyncStatus = {
    lastRunAt: new Date().toISOString(),
    provider: 'sbt',
    modulePath: '.',
    moduleArtifactId: options.workspaceFolder.name,
    jarsCount: classpathResult.jars.length,
    outputDirCount: classpathResult.outputDirs.length,
    jdkHome: jdkResult.home,
    jdkSource: jdkResult.source,
    selectedJdkModuleCount: jdkResult.selectedModules.length,
    availableJdkModuleCount: jdkResult.availableModules.length,
    cacheFilePath: classpathResult.cacheFilePath,
    durationMs: Date.now() - startedAt,
    success: true
  };

  await writeCacheJson(options.workspaceFolder, SYNC_STATUS_FILE, status);
  return status;
}

export async function writeDependencySyncFailure(
  workspaceFolder: vscode.WorkspaceFolder,
  provider: ClasspathProvider,
  errorMessage: string,
  startedAt: number
): Promise<void> {
  const status: DependencySyncStatus = {
    lastRunAt: new Date().toISOString(),
    provider,
    jarsCount: 0,
    outputDirCount: 0,
    selectedJdkModuleCount: 0,
    availableJdkModuleCount: 0,
    durationMs: Math.max(0, Date.now() - startedAt),
    success: false,
    errorMessage
  };

  await writeCacheJson(workspaceFolder, SYNC_STATUS_FILE, status);
}

export async function readDependencySyncStatus(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<DependencySyncStatus | undefined> {
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return undefined;
  }

  const statusUri = vscode.Uri.joinPath(cacheRoot, SYNC_STATUS_FILE);
  try {
    const raw = await vscode.workspace.fs.readFile(statusUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as DependencySyncStatus;
    return parsed;
  } catch {
    return undefined;
  }
}
