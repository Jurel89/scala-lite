import * as vscode from 'vscode';

const SCALA_LITE_CACHE_DIR = '.scala-lite';
const GITIGNORE_CONTENT = '*\n';
const DEFAULT_MAX_SNAPSHOTS_PER_KEY = 3;
const DEFAULT_MAX_CACHE_BYTES = 200 * 1024 * 1024;

const CLASSPATH_FILE_PATTERN = /^classpath-([a-f0-9]{12})\.json$/;
const DEP_INDEX_FILE_PATTERN = /^deps-index-([a-f0-9]{12})\.bin$/;
const JDK_INDEX_FILE_PATTERN = /^jdk-index-(.+)\.bin$/;
const DEP_SYNC_STATUS_FILE_PATTERN = /^dependency-sync-status\.json$/;

interface SnapshotFileMeta {
  readonly name: string;
  readonly uri: vscode.Uri;
  readonly size: number;
  readonly mtime: number;
  readonly groupKey: string;
}

export interface ScalaLiteCacheGcResult {
  readonly triggered: boolean;
  readonly evictedFiles: number;
  readonly reclaimedBytes: number;
  readonly totalBytesBefore: number;
  readonly totalBytesAfter: number;
}

export interface ScalaLiteCacheGcOptions {
  readonly maxSnapshotsPerGroup?: number;
  readonly maxTotalBytes?: number;
}

export interface ScalaLiteCacheSummary {
  readonly exists: boolean;
  readonly totalBytes: number;
}

function parseSnapshotGroupKey(fileName: string): string | undefined {
  const classpathMatch = CLASSPATH_FILE_PATTERN.exec(fileName);
  if (classpathMatch) {
    return `classpath:${classpathMatch[1]}`;
  }

  const depIndexMatch = DEP_INDEX_FILE_PATTERN.exec(fileName);
  if (depIndexMatch) {
    return `deps-index:${depIndexMatch[1]}`;
  }

  const jdkIndexMatch = JDK_INDEX_FILE_PATTERN.exec(fileName);
  if (jdkIndexMatch) {
    return `jdk-index:${jdkIndexMatch[1]}`;
  }

  return undefined;
}

function isDependencyIndexCacheFile(fileName: string): boolean {
  return CLASSPATH_FILE_PATTERN.test(fileName)
    || DEP_INDEX_FILE_PATTERN.test(fileName)
    || JDK_INDEX_FILE_PATTERN.test(fileName)
    || DEP_SYNC_STATUS_FILE_PATTERN.test(fileName);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deleteCacheEntryWithRetry(uri: vscode.Uri): Promise<boolean> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldRetry = /EBUSY|EPERM|ENOTEMPTY|resource busy/i.test(message);
      if (!shouldRetry || attempt >= maxAttempts) {
        return false;
      }

      await delay(25 * attempt);
    }
  }

  return false;
}

async function readSnapshotFiles(cacheUri: vscode.Uri): Promise<readonly SnapshotFileMeta[]> {
  let entries: readonly [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(cacheUri);
  } catch {
    return [];
  }

  const snapshots: SnapshotFileMeta[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) {
      continue;
    }

    const groupKey = parseSnapshotGroupKey(name);
    if (!groupKey) {
      continue;
    }

    const uri = vscode.Uri.joinPath(cacheUri, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      snapshots.push({
        name,
        uri,
        size: stat.size,
        mtime: stat.mtime,
        groupKey
      });
    } catch {
      continue;
    }
  }

  return snapshots;
}

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

export function getScalaLiteCacheUri(folder?: vscode.WorkspaceFolder): vscode.Uri | undefined {
  const targetFolder = folder ?? getPrimaryWorkspaceFolder();
  if (!targetFolder) {
    return undefined;
  }

  return vscode.Uri.joinPath(targetFolder.uri, SCALA_LITE_CACHE_DIR);
}

export async function ensureScalaLiteCacheDir(folder?: vscode.WorkspaceFolder): Promise<vscode.Uri | undefined> {
  const cacheUri = getScalaLiteCacheUri(folder);
  if (!cacheUri) {
    return undefined;
  }

  await vscode.workspace.fs.createDirectory(cacheUri);

  const gitignoreUri = vscode.Uri.joinPath(cacheUri, '.gitignore');
  try {
    await vscode.workspace.fs.stat(gitignoreUri);
  } catch {
    await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(GITIGNORE_CONTENT, 'utf8'));
  }

  return cacheUri;
}

export async function hasDependencyIndexCache(folder?: vscode.WorkspaceFolder): Promise<boolean> {
  const cacheUri = getScalaLiteCacheUri(folder);
  if (!cacheUri) {
    return false;
  }

  let entries: readonly [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(cacheUri);
  } catch {
    return false;
  }

  return entries.some(([name, type]) => type === vscode.FileType.File && isDependencyIndexCacheFile(name));
}

export async function pruneScalaLiteCacheSnapshots(
  folder?: vscode.WorkspaceFolder,
  options?: ScalaLiteCacheGcOptions
): Promise<ScalaLiteCacheGcResult> {
  const cacheUri = getScalaLiteCacheUri(folder);
  if (!cacheUri) {
    return {
      triggered: false,
      evictedFiles: 0,
      reclaimedBytes: 0,
      totalBytesBefore: 0,
      totalBytesAfter: 0
    };
  }

  const summaryBefore = await getScalaLiteCacheSummary(folder);
  if (!summaryBefore.exists) {
    return {
      triggered: false,
      evictedFiles: 0,
      reclaimedBytes: 0,
      totalBytesBefore: 0,
      totalBytesAfter: 0
    };
  }

  const maxSnapshotsPerGroup = Math.max(1, options?.maxSnapshotsPerGroup ?? DEFAULT_MAX_SNAPSHOTS_PER_KEY);
  const maxTotalBytes = Math.max(1, options?.maxTotalBytes ?? DEFAULT_MAX_CACHE_BYTES);
  const snapshots = await readSnapshotFiles(cacheUri);
  const snapshotBytesBefore = snapshots.reduce((sum, snapshot) => sum + snapshot.size, 0);
  if (snapshots.length === 0) {
    return {
      triggered: false,
      evictedFiles: 0,
      reclaimedBytes: 0,
      totalBytesBefore: 0,
      totalBytesAfter: 0
    };
  }

  const byGroup = new Map<string, SnapshotFileMeta[]>();
  for (const snapshot of snapshots) {
    const existing = byGroup.get(snapshot.groupKey) ?? [];
    existing.push(snapshot);
    byGroup.set(snapshot.groupKey, existing);
  }

  const evictedNames = new Set<string>();
  let evictedFiles = 0;
  let reclaimedBytes = 0;
  let runningTotalBytes = snapshotBytesBefore;

  for (const groupedSnapshots of byGroup.values()) {
    groupedSnapshots.sort((left, right) => right.mtime - left.mtime);
    const stale = groupedSnapshots.slice(maxSnapshotsPerGroup);
    for (const staleSnapshot of stale) {
      const removed = await deleteCacheEntryWithRetry(staleSnapshot.uri);
      if (!removed) {
        continue;
      }

      evictedNames.add(staleSnapshot.name);
      evictedFiles += 1;
      reclaimedBytes += staleSnapshot.size;
      runningTotalBytes = Math.max(0, runningTotalBytes - staleSnapshot.size);
    }
  }

  if (runningTotalBytes > maxTotalBytes) {
    const remainingSnapshots = snapshots
      .filter((snapshot) => !evictedNames.has(snapshot.name))
      .sort((left, right) => left.mtime - right.mtime);

    for (const candidate of remainingSnapshots) {
      if (runningTotalBytes <= maxTotalBytes) {
        break;
      }

      const removed = await deleteCacheEntryWithRetry(candidate.uri);
      if (!removed) {
        continue;
      }

      evictedNames.add(candidate.name);
      evictedFiles += 1;
      reclaimedBytes += candidate.size;
      runningTotalBytes = Math.max(0, runningTotalBytes - candidate.size);
    }
  }

  if (evictedFiles > 0) {
    console.warn(
      `Scala Lite cache GC evicted ${evictedFiles} snapshot file(s), reclaimed ${reclaimedBytes} bytes (cap ${maxTotalBytes} bytes).`
    );
  }

  return {
    triggered: evictedFiles > 0,
    evictedFiles,
    reclaimedBytes,
    totalBytesBefore: snapshotBytesBefore,
    totalBytesAfter: runningTotalBytes
  };
}

export async function resetScalaLiteCache(folder?: vscode.WorkspaceFolder): Promise<boolean> {
  const cacheUri = getScalaLiteCacheUri(folder);
  if (!cacheUri) {
    return false;
  }

  try {
    await vscode.workspace.fs.stat(cacheUri);
  } catch {
    return false;
  }

  const entries = await vscode.workspace.fs.readDirectory(cacheUri);
  for (const [name] of entries) {
    const childUri = vscode.Uri.joinPath(cacheUri, name);
    await deleteCacheEntryWithRetry(childUri);
  }

  await ensureScalaLiteCacheDir(folder);
  return true;
}

export async function getScalaLiteCacheSummary(folder?: vscode.WorkspaceFolder): Promise<ScalaLiteCacheSummary> {
  const cacheUri = getScalaLiteCacheUri(folder);
  if (!cacheUri) {
    return {
      exists: false,
      totalBytes: 0
    };
  }

  try {
    await vscode.workspace.fs.stat(cacheUri);
  } catch {
    return {
      exists: false,
      totalBytes: 0
    };
  }

  let totalBytes = 0;
  const stack: vscode.Uri[] = [cacheUri];

  while (stack.length > 0) {
    const currentUri = stack.pop();
    if (!currentUri) {
      continue;
    }

    const entries = await vscode.workspace.fs.readDirectory(currentUri);
    for (const [name, fileType] of entries) {
      const entryUri = vscode.Uri.joinPath(currentUri, name);
      if (fileType === vscode.FileType.Directory) {
        stack.push(entryUri);
        continue;
      }

      if (fileType === vscode.FileType.File) {
        const stat = await vscode.workspace.fs.stat(entryUri);
        totalBytes += stat.size;
      }
    }
  }

  return {
    exists: true,
    totalBytes
  };
}
