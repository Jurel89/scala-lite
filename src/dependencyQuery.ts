import * as path from 'node:path';
import * as vscode from 'vscode';
import { readDependencyAttachmentsByJar } from './dependencyArtifacts';
import { getNativeEngine } from './nativeEngineState';
import { IndexedSymbol } from './symbolIndex';
import { getScalaLiteCacheUri } from './scalaLiteCache';

interface CachedClasspathPayload {
  readonly version?: number;
  readonly buildTool?: string;
  readonly jars?: readonly string[];
  readonly outputDirs?: readonly string[];
  readonly resolvedAt?: string;
}

let lastDependencyHotMemoryBytes = 0;

function estimateStringBytes(value: string | undefined): number {
  if (typeof value !== 'string') {
    return 0;
  }

  return Buffer.byteLength(value, 'utf8');
}

function estimateStringArrayBytes(values: readonly string[] | undefined): number {
  if (!Array.isArray(values)) {
    return 0;
  }

  return values.reduce((sum, value) => sum + estimateStringBytes(value), 0);
}

function estimateClasspathPayloadBytes(payload: CachedClasspathPayload | undefined): number {
  if (!payload) {
    return 0;
  }

  let total = 0;
  total += estimateStringBytes(payload.buildTool);
  total += estimateStringArrayBytes(payload.jars);
  total += estimateStringArrayBytes(payload.outputDirs);
  total += estimateStringBytes(payload.resolvedAt);
  total += 64;

  return total;
}

function estimateAttachmentMapBytes(attachmentsByJar: ReadonlyMap<string, { readonly sourcesPath?: string }>): number {
  let total = 0;

  for (const [jarPath, attachment] of attachmentsByJar.entries()) {
    total += estimateStringBytes(jarPath);
    total += estimateStringBytes(attachment.sourcesPath);
    total += 32;
  }

  return total;
}

export function getDependencyHotMemoryUsageBytes(): number {
  return Math.max(0, Math.round(lastDependencyHotMemoryBytes));
}

function stripJarExtension(fileName: string): string {
  return fileName.endsWith('.jar') ? fileName.slice(0, -4) : fileName;
}

function artifactNameFromJarPath(jarPath: string): string {
  const baseName = stripJarExtension(path.basename(jarPath));
  const normalized = baseName.replace(/[-_]?\d+(?:\.\d+)*(?:[-.][A-Za-z0-9]+)*/g, '').replace(/[-_]+$/, '');
  return normalized.length > 0 ? normalized : baseName;
}

function toDependencySymbol(jarPath: string, attachedSourcePath: string | undefined): IndexedSymbol {
  return {
    symbolName: artifactNameFromJarPath(jarPath),
    symbolKind: 'class',
    filePath: attachedSourcePath ?? jarPath,
    lineNumber: 1,
    packageName: 'dependency',
    visibility: 'public'
  };
}

async function readClasspathCacheFiles(workspaceFolder: vscode.WorkspaceFolder): Promise<readonly vscode.Uri[]> {
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

  return entries
    .filter(([name, type]) => type === vscode.FileType.File && /^classpath-.*\.json$/.test(name))
    .map(([name]) => vscode.Uri.joinPath(cacheRoot, name));
}

async function readClasspathPayload(uri: vscode.Uri): Promise<CachedClasspathPayload | undefined> {
  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(raw).toString('utf8')) as CachedClasspathPayload;
  } catch {
    return undefined;
  }
}

export async function queryDependencySymbols(
  workspaceFolder: vscode.WorkspaceFolder,
  query: string,
  limit: number
): Promise<readonly IndexedSymbol[]> {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return [];
  }

  const classpathFiles = await readClasspathCacheFiles(workspaceFolder);
  if (classpathFiles.length === 0) {
    return [];
  }

  const payloads = await Promise.all(classpathFiles.map(async (uri) => readClasspathPayload(uri)));
  const attachmentsByJar = await readDependencyAttachmentsByJar(workspaceFolder);
  let nativeDependencyBytes = 0;
  try {
    nativeDependencyBytes = await getNativeEngine().getTotalDependencyMemoryUsageBytes();
  } catch {
    nativeDependencyBytes = 0;
  }

  lastDependencyHotMemoryBytes = payloads
    .reduce((sum, payload) => sum + estimateClasspathPayloadBytes(payload), 0)
    + estimateAttachmentMapBytes(attachmentsByJar)
    + nativeDependencyBytes;
  const symbols: IndexedSymbol[] = [];

  for (const payload of payloads) {
    const jars = payload?.jars ?? [];
    for (const jarPath of jars) {
      if (typeof jarPath !== 'string' || jarPath.length === 0) {
        continue;
      }

      const symbol = toDependencySymbol(jarPath, attachmentsByJar.get(jarPath)?.sourcesPath);
      if (!symbol.symbolName.toLowerCase().includes(normalizedQuery)) {
        continue;
      }

      symbols.push(symbol);
      if (symbols.length >= limit) {
        return symbols;
      }
    }
  }

  return symbols;
}
