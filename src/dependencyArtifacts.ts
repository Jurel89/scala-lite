import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { executeBuildCommand } from './buildCommandExecutor';
import { ensureScalaLiteCacheDir, getScalaLiteCacheUri } from './scalaLiteCache';
import { formatStructuredLogEntry } from './structuredLogCore';
import { EffectiveBuildConfig } from './workspaceConfig';

const ATTACHMENTS_FILE = 'dependency-attachments.json';
const SOURCES_CACHE_DIR = 'sources-cache';
const SOURCES_CACHE_INDEX_FILE = 'sources-cache-index.json';
const DEFAULT_MAX_SOURCES_CACHE_BYTES = 512 * 1024 * 1024;

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

interface SourcesCacheIndexEntry {
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly lastAccessedAt: string;
}

interface SourcesCacheIndex {
  readonly version: 1;
  readonly generatedAt: string;
  readonly maxBytes: number;
  readonly entries: readonly SourcesCacheIndexEntry[];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toSourcesCacheFileName(sourcePath: string): string {
  const ext = path.extname(sourcePath) || '.jar';
  const baseName = path.basename(sourcePath, ext)
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 80);
  const digest = crypto.createHash('sha1').update(sourcePath).digest('hex').slice(0, 12);
  return `${baseName.length > 0 ? baseName : 'artifact'}-${digest}${ext}`;
}

async function readSourcesCacheIndex(workspaceFolder: vscode.WorkspaceFolder): Promise<SourcesCacheIndex> {
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      maxBytes: DEFAULT_MAX_SOURCES_CACHE_BYTES,
      entries: []
    };
  }

  const indexUri = vscode.Uri.joinPath(cacheRoot, SOURCES_CACHE_INDEX_FILE);
  try {
    const raw = await vscode.workspace.fs.readFile(indexUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as Partial<SourcesCacheIndex>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter((entry): entry is SourcesCacheIndexEntry => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }

        const typed = entry as Partial<SourcesCacheIndexEntry>;
        return typeof typed.relativePath === 'string'
          && typed.relativePath.length > 0
          && typeof typed.sizeBytes === 'number'
          && Number.isFinite(typed.sizeBytes)
          && typed.sizeBytes >= 0
          && typeof typed.lastAccessedAt === 'string'
          && typed.lastAccessedAt.length > 0;
      })
      : [];

    return {
      version: 1,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : new Date().toISOString(),
      maxBytes: DEFAULT_MAX_SOURCES_CACHE_BYTES,
      entries
    };
  } catch {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      maxBytes: DEFAULT_MAX_SOURCES_CACHE_BYTES,
      entries: []
    };
  }
}

async function writeSourcesCacheIndex(
  workspaceFolder: vscode.WorkspaceFolder,
  entries: readonly SourcesCacheIndexEntry[]
): Promise<void> {
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return;
  }

  const indexUri = vscode.Uri.joinPath(cacheRoot, SOURCES_CACHE_INDEX_FILE);
  const payload: SourcesCacheIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    maxBytes: DEFAULT_MAX_SOURCES_CACHE_BYTES,
    entries
  };

  await vscode.workspace.fs.writeFile(indexUri, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
}

async function ensureSourcesCacheDir(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  const cacheRoot = await ensureScalaLiteCacheDir(workspaceFolder);
  if (!cacheRoot) {
    return undefined;
  }

  const sourcesCacheUri = vscode.Uri.joinPath(cacheRoot, SOURCES_CACHE_DIR);
  await vscode.workspace.fs.createDirectory(sourcesCacheUri);
  return sourcesCacheUri;
}

async function upsertSourcesCacheEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  entry: SourcesCacheIndexEntry
): Promise<void> {
  const current = await readSourcesCacheIndex(workspaceFolder);
  const nextEntries = [
    ...current.entries.filter((existing) => existing.relativePath !== entry.relativePath),
    entry
  ];
  await writeSourcesCacheIndex(workspaceFolder, nextEntries);
}

function toEpochMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function enforceSourcesCacheLru(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return;
  }

  const index = await readSourcesCacheIndex(workspaceFolder);
  const normalizedEntries: SourcesCacheIndexEntry[] = [];
  let totalBytes = 0;

  for (const entry of index.entries) {
    const targetUri = vscode.Uri.joinPath(cacheRoot, SOURCES_CACHE_DIR, entry.relativePath);
    try {
      const stat = await vscode.workspace.fs.stat(targetUri);
      const normalized: SourcesCacheIndexEntry = {
        relativePath: entry.relativePath,
        sizeBytes: stat.size,
        lastAccessedAt: entry.lastAccessedAt
      };
      normalizedEntries.push(normalized);
      totalBytes += stat.size;
    } catch {
      continue;
    }
  }

  if (totalBytes <= DEFAULT_MAX_SOURCES_CACHE_BYTES) {
    await writeSourcesCacheIndex(workspaceFolder, normalizedEntries);
    return;
  }

  const evicted: SourcesCacheIndexEntry[] = [];
  const ordered = [...normalizedEntries].sort((left, right) => toEpochMillis(left.lastAccessedAt) - toEpochMillis(right.lastAccessedAt));
  const kept = [...normalizedEntries];
  let runningBytes = totalBytes;

  for (const entry of ordered) {
    if (runningBytes <= DEFAULT_MAX_SOURCES_CACHE_BYTES) {
      break;
    }

    const targetUri = vscode.Uri.joinPath(cacheRoot, SOURCES_CACHE_DIR, entry.relativePath);
    try {
      await vscode.workspace.fs.delete(targetUri, { recursive: false, useTrash: false });
      runningBytes = Math.max(0, runningBytes - entry.sizeBytes);
      evicted.push(entry);
      const indexToRemove = kept.findIndex((candidate) => candidate.relativePath === entry.relativePath);
      if (indexToRemove >= 0) {
        kept.splice(indexToRemove, 1);
      }
    } catch {
      continue;
    }
  }

  await writeSourcesCacheIndex(workspaceFolder, kept);

  if (evicted.length > 0) {
    const reclaimed = evicted.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const logLine = formatStructuredLogEntry({
      timestamp: new Date(),
      level: 'WARN',
      category: 'CONFIG',
      message: `sources-cache LRU evicted ${evicted.length} item(s), reclaimed ${reclaimed} bytes, cap ${DEFAULT_MAX_SOURCES_CACHE_BYTES} bytes`
    });
    console.warn(logLine);
  }
}

async function cacheAttachmentArtifact(
  workspaceFolder: vscode.WorkspaceFolder,
  sourcePath: string | undefined
): Promise<string | undefined> {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0) {
    return undefined;
  }

  const sourcesCacheUri = await ensureSourcesCacheDir(workspaceFolder);
  if (!sourcesCacheUri) {
    return sourcePath;
  }

  const fileName = toSourcesCacheFileName(sourcePath);
  const destinationUri = vscode.Uri.joinPath(sourcesCacheUri, fileName);
  const destinationPath = destinationUri.fsPath;

  try {
    if (!(await fileExists(destinationPath))) {
      await fs.copyFile(sourcePath, destinationPath);
    }

    const stat = await fs.stat(destinationPath);
    await upsertSourcesCacheEntry(workspaceFolder, {
      relativePath: fileName,
      sizeBytes: stat.size,
      lastAccessedAt: new Date().toISOString()
    });

    await enforceSourcesCacheLru(workspaceFolder);
    return destinationPath;
  } catch {
    return sourcePath;
  }
}

async function touchSourcesCacheEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  artifactPath: string | undefined
): Promise<void> {
  if (typeof artifactPath !== 'string' || artifactPath.length === 0) {
    return;
  }

  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    return;
  }

  const relativeToCache = path.relative(path.join(cacheRoot.fsPath, SOURCES_CACHE_DIR), artifactPath);
  if (relativeToCache.startsWith('..') || path.isAbsolute(relativeToCache)) {
    return;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(artifactPath);
  } catch {
    return;
  }

  await upsertSourcesCacheEntry(workspaceFolder, {
    relativePath: relativeToCache,
    sizeBytes: stat.size,
    lastAccessedAt: new Date().toISOString()
  });
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

    const cachedSourcesPath = hasSources
      ? await cacheAttachmentArtifact(options.workspaceFolder, sourcesPathCandidate)
      : undefined;
    const cachedJavadocPath = hasJavadoc
      ? await cacheAttachmentArtifact(options.workspaceFolder, javadocPathCandidate)
      : undefined;

    return {
      jarPath,
      sourcesPath: hasSources ? cachedSourcesPath : undefined,
      javadocPath: hasJavadoc ? cachedJavadocPath : undefined
    };
  }));

  await writeAttachments(options.workspaceFolder, attachments);
  await enforceSourcesCacheLru(options.workspaceFolder);

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

      await Promise.all([
        touchSourcesCacheEntry(workspaceFolder, entry.sourcesPath),
        touchSourcesCacheEntry(workspaceFolder, entry.javadocPath)
      ]);

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
