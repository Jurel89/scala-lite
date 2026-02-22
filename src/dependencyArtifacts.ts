import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { executeBuildCommand } from './buildCommandExecutor';
import { ensureScalaLiteCacheDir, getScalaLiteCacheUri } from './scalaLiteCache';
import { EffectiveBuildConfig } from './workspaceConfig';

const ATTACHMENTS_FILE = 'dependency-attachments.json';

interface CachedClasspathPayload {
  readonly jars?: readonly string[];
}

export interface DependencyAttachment {
  readonly jarPath: string;
  readonly sourcesPath?: string;
  readonly javadocPath?: string;
}

export interface DependencyAttachmentSummary {
  readonly totalJars: number;
  readonly attachedSources: number;
  readonly attachedJavadocs: number;
}

export interface FetchDependencyArtifactsOptions {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly provider: 'maven' | 'sbt';
  readonly buildConfig: EffectiveBuildConfig;
  readonly cancellationToken: vscode.CancellationToken;
  readonly timeoutMs?: number;
  readonly onOutput?: (line: string) => void;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readClasspathJars(workspaceFolder: vscode.WorkspaceFolder): Promise<readonly string[]> {
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return [];
  }

  let entries: readonly [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(cacheRoot);
  } catch {
    return [];
  }

  const classpathUris = entries
    .filter(([name, type]) => type === vscode.FileType.File && /^classpath-.*\.json$/.test(name))
    .map(([name]) => vscode.Uri.joinPath(cacheRoot, name));

  const payloads = await Promise.all(classpathUris.map(async (uri) => {
    try {
      const raw = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(Buffer.from(raw).toString('utf8')) as CachedClasspathPayload;
    } catch {
      return undefined;
    }
  }));

  const jars = payloads
    .flatMap((payload) => payload?.jars ?? [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);

  return Array.from(new Set(jars));
}

function classifierCandidate(jarPath: string, classifier: 'sources' | 'javadoc'): string {
  if (!jarPath.endsWith('.jar')) {
    return jarPath;
  }

  return `${jarPath.slice(0, -4)}-${classifier}.jar`;
}

async function resolveMavenExecutable(workspaceRoot: string, overridePath: string | undefined): Promise<string> {
  if (overridePath && overridePath.trim().length > 0) {
    const customPath = path.isAbsolute(overridePath) ? overridePath : path.join(workspaceRoot, overridePath);
    return customPath;
  }

  const wrapperCandidates = process.platform === 'win32' ? ['mvnw.cmd', 'mvnw'] : ['mvnw'];
  for (const wrapper of wrapperCandidates) {
    const candidate = path.join(workspaceRoot, wrapper);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return 'mvn';
}

async function resolveSbtExecutable(workspaceRoot: string): Promise<string> {
  const wrapperCandidates = process.platform === 'win32' ? ['sbt.bat', 'sbt'] : ['sbt'];
  for (const wrapper of wrapperCandidates) {
    const candidate = path.join(workspaceRoot, wrapper);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return 'sbt';
}

async function runFetchCommand(options: FetchDependencyArtifactsOptions): Promise<void> {
  const workspaceRoot = options.workspaceFolder.uri.fsPath;
  const timeoutMs = options.timeoutMs ?? 120_000;

  if (options.provider === 'maven') {
    const executable = await resolveMavenExecutable(workspaceRoot, options.buildConfig.mavenWrapperPath);
    const args: string[] = [
      'dependency:sources',
      'dependency:resolve',
      '-Dclassifier=javadoc'
    ];

    if (options.buildConfig.mavenProfiles.length > 0) {
      args.push(`-P${options.buildConfig.mavenProfiles.join(',')}`);
    }

    args.push(...options.buildConfig.mavenArgs);

    const result = await executeBuildCommand({
      command: executable,
      args,
      cwd: workspaceRoot,
      timeoutMs,
      cancellationToken: options.cancellationToken,
      onStdout: options.onOutput,
      onStderr: options.onOutput
    });

    if (result.wasCancelled) {
      throw new Error('Dependency source fetch cancelled.');
    }
    if (result.timedOut) {
      throw new Error(`Dependency source fetch timed out after ${timeoutMs}ms.`);
    }
    if (result.exitCode !== 0) {
      throw new Error(result.combinedOutput.split(/\r?\n/).slice(-8).join('\n').trim() || `Maven command failed with exit code ${result.exitCode}.`);
    }

    return;
  }

  const executable = await resolveSbtExecutable(workspaceRoot);
  const args: string[] = ['-no-colors', ...options.buildConfig.sbtArgs, 'updateClassifiers'];

  const result = await executeBuildCommand({
    command: executable,
    args,
    cwd: workspaceRoot,
    timeoutMs,
    cancellationToken: options.cancellationToken,
    onStdout: options.onOutput,
    onStderr: options.onOutput
  });

  if (result.wasCancelled) {
    throw new Error('Dependency source fetch cancelled.');
  }
  if (result.timedOut) {
    throw new Error(`Dependency source fetch timed out after ${timeoutMs}ms.`);
  }
  if (result.exitCode !== 0) {
    throw new Error(result.combinedOutput.split(/\r?\n/).slice(-8).join('\n').trim() || `SBT command failed with exit code ${result.exitCode}.`);
  }
}

async function writeAttachments(
  workspaceFolder: vscode.WorkspaceFolder,
  attachments: readonly DependencyAttachment[]
): Promise<void> {
  const cacheRoot = await ensureScalaLiteCacheDir(workspaceFolder);
  if (!cacheRoot) {
    return;
  }

  const target = vscode.Uri.joinPath(cacheRoot, ATTACHMENTS_FILE);
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    attachments
  };
  await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
}

export async function fetchDependencyArtifacts(options: FetchDependencyArtifactsOptions): Promise<DependencyAttachmentSummary> {
  await runFetchCommand(options);

  const jars = await readClasspathJars(options.workspaceFolder);
  const attachments = await Promise.all(jars.map(async (jarPath): Promise<DependencyAttachment> => {
    const sourcesPathCandidate = classifierCandidate(jarPath, 'sources');
    const javadocPathCandidate = classifierCandidate(jarPath, 'javadoc');

    const [hasSources, hasJavadoc] = await Promise.all([
      fileExists(sourcesPathCandidate),
      fileExists(javadocPathCandidate)
    ]);

    return {
      jarPath,
      sourcesPath: hasSources ? sourcesPathCandidate : undefined,
      javadocPath: hasJavadoc ? javadocPathCandidate : undefined
    };
  }));

  await writeAttachments(options.workspaceFolder, attachments);

  return {
    totalJars: jars.length,
    attachedSources: attachments.filter((entry) => typeof entry.sourcesPath === 'string').length,
    attachedJavadocs: attachments.filter((entry) => typeof entry.javadocPath === 'string').length
  };
}

export async function readDependencyAttachmentsByJar(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<ReadonlyMap<string, DependencyAttachment>> {
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return new Map();
  }

  const target = vscode.Uri.joinPath(cacheRoot, ATTACHMENTS_FILE);
  try {
    const raw = await vscode.workspace.fs.readFile(target);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as {
      readonly attachments?: readonly DependencyAttachment[];
    };

    const map = new Map<string, DependencyAttachment>();
    for (const entry of parsed.attachments ?? []) {
      if (!entry || typeof entry.jarPath !== 'string' || entry.jarPath.length === 0) {
        continue;
      }

      map.set(entry.jarPath, entry);
    }

    return map;
  } catch {
    return new Map();
  }
}

export async function readDependencyAttachmentSummary(
  workspaceFolder: vscode.WorkspaceFolder
): Promise<DependencyAttachmentSummary | undefined> {
  const attachments = await readDependencyAttachmentsByJar(workspaceFolder);
  if (attachments.size === 0) {
    return undefined;
  }

  const values = Array.from(attachments.values());
  return {
    totalJars: values.length,
    attachedSources: values.filter((entry) => typeof entry.sourcesPath === 'string').length,
    attachedJavadocs: values.filter((entry) => typeof entry.javadocPath === 'string').length
  };
}

export async function readDependencyAttachmentForPath(
  workspaceFolder: vscode.WorkspaceFolder,
  artifactPath: string
): Promise<DependencyAttachment | undefined> {
  const attachments = await readDependencyAttachmentsByJar(workspaceFolder);
  for (const entry of attachments.values()) {
    if (entry.jarPath === artifactPath || entry.sourcesPath === artifactPath || entry.javadocPath === artifactPath) {
      return entry;
    }
  }

  return undefined;
}
