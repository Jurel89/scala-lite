import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { executeBuildCommand } from './buildCommandExecutor';
import { ensureScalaLiteCacheDir, getScalaLiteCacheUri, pruneScalaLiteCacheSnapshots } from './scalaLiteCache';

export interface ResolveSbtClasspathOptions {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly includeTestScope: boolean;
  readonly strategy: 'auto' | 'coursier' | 'sbt-show';
  readonly extraArgs: readonly string[];
  readonly timeoutMs: number;
  readonly cancellationToken: vscode.CancellationToken;
  readonly onOutput?: (line: string) => void;
}

export interface SbtClasspathResult {
  readonly jars: readonly string[];
  readonly outputDirs: readonly string[];
  readonly cacheFilePath: string;
  readonly strategyUsed: 'coursier' | 'sbt-show';
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveSbtExecutable(workspaceRoot: string): Promise<string> {
  const candidates = process.platform === 'win32'
    ? ['sbt.bat', 'sbt']
    : ['sbt'];

  for (const candidate of candidates) {
    const absolute = path.join(workspaceRoot, candidate);
    if (await fileExists(absolute)) {
      return absolute;
    }
  }

  return 'sbt';
}

function normalizeClasspathEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const noPrefix = trimmed.replace(/^\[\w+\]\s*/, '');
  const attributedMatch = noPrefix.match(/Attributed\((.*)\)/);
  const candidate = attributedMatch?.[1] ?? noPrefix;

  const unquoted = candidate.replace(/^"|"$/g, '').trim();
  if (!path.isAbsolute(unquoted)) {
    return undefined;
  }

  if (unquoted.endsWith('.jar') || /classes$/.test(unquoted)) {
    return unquoted;
  }

  return undefined;
}

function parseSbtClasspath(output: string): readonly string[] {
  const parsed = output
    .split(/\r?\n/)
    .map((line) => normalizeClasspathEntry(line))
    .filter((entry): entry is string => typeof entry === 'string');

  return Array.from(new Set(parsed));
}

function chooseStrategy(strategy: 'auto' | 'coursier' | 'sbt-show'): 'auto' | 'coursier' | 'sbt-show' {
  return strategy;
}

function buildSbtCommands(
  strategy: 'coursier' | 'sbt-show',
  includeTestScope: boolean
): readonly string[] {
  if (strategy === 'coursier') {
    return includeTestScope
      ? ['show Compile / dependencyClasspath', 'show Test / dependencyClasspath']
      : ['show Compile / dependencyClasspath'];
  }

  return includeTestScope
    ? ['show Compile / fullClasspath', 'show Test / fullClasspath']
    : ['show Compile / fullClasspath'];
}

function buildOutputDirs(workspaceRoot: string, includeTestScope: boolean): readonly string[] {
  const candidates = [
    path.join(workspaceRoot, 'target', 'scala-2.12', 'classes'),
    path.join(workspaceRoot, 'target', 'scala-2.13', 'classes'),
    path.join(workspaceRoot, 'target', 'scala-3', 'classes'),
    path.join(workspaceRoot, 'target', 'classes')
  ];

  if (includeTestScope) {
    candidates.push(
      path.join(workspaceRoot, 'target', 'scala-2.12', 'test-classes'),
      path.join(workspaceRoot, 'target', 'scala-2.13', 'test-classes'),
      path.join(workspaceRoot, 'target', 'scala-3', 'test-classes'),
      path.join(workspaceRoot, 'target', 'test-classes')
    );
  }

  return Array.from(new Set(candidates));
}

async function writeClasspathCache(
  workspaceFolder: vscode.WorkspaceFolder,
  jars: readonly string[],
  outputDirs: readonly string[],
  strategy: 'coursier' | 'sbt-show'
): Promise<string> {
  await ensureScalaLiteCacheDir(workspaceFolder);
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    throw new Error('Workspace root unavailable for classpath cache.');
  }

  const hash = crypto.createHash('sha1').update('sbt:.').digest('hex').slice(0, 12);
  const cacheUri = vscode.Uri.joinPath(cacheRoot, `classpath-${hash}.json`);
  const payload = {
    version: 1,
    buildTool: 'sbt',
    module: path.basename(workspaceFolder.uri.fsPath),
    modulePath: '.',
    resolvedAt: new Date().toISOString(),
    jars,
    outputDirs,
    sbtStrategy: strategy
  };

  await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
  await pruneScalaLiteCacheSnapshots(workspaceFolder);
  return cacheUri.fsPath;
}

async function runSbtClasspathWithStrategy(
  options: ResolveSbtClasspathOptions,
  strategy: 'coursier' | 'sbt-show'
): Promise<SbtClasspathResult> {
  const workspaceRoot = options.workspaceFolder.uri.fsPath;
  const executable = await resolveSbtExecutable(workspaceRoot);
  const commands = buildSbtCommands(strategy, options.includeTestScope);

  const args: string[] = ['-no-colors', ...options.extraArgs, ...commands];

  const result = await executeBuildCommand({
    command: executable,
    args,
    cwd: workspaceRoot,
    timeoutMs: options.timeoutMs,
    cancellationToken: options.cancellationToken,
    onStdout: options.onOutput,
    onStderr: options.onOutput
  });

  if (result.wasCancelled) {
    throw new Error('Classpath sync cancelled.');
  }

  if (result.timedOut) {
    throw new Error(`SBT command timed out after ${options.timeoutMs}ms.`);
  }

  if (result.exitCode !== 0) {
    const outputExcerpt = result.combinedOutput.split(/\r?\n/).slice(-8).join('\n').trim();
    throw new Error(outputExcerpt.length > 0 ? outputExcerpt : `SBT command failed with exit code ${result.exitCode}.`);
  }

  const classpathEntries = parseSbtClasspath(result.combinedOutput);
  const jars = classpathEntries.filter((entry) => entry.endsWith('.jar'));
  const outputDirs = buildOutputDirs(workspaceRoot, options.includeTestScope);
  const cacheFilePath = await writeClasspathCache(options.workspaceFolder, jars, outputDirs, strategy);

  return {
    jars,
    outputDirs,
    cacheFilePath,
    strategyUsed: strategy
  };
}

export async function resolveSbtClasspath(options: ResolveSbtClasspathOptions): Promise<SbtClasspathResult> {
  const strategy = chooseStrategy(options.strategy);
  if (strategy === 'coursier' || strategy === 'sbt-show') {
    return runSbtClasspathWithStrategy(options, strategy);
  }

  try {
    return await runSbtClasspathWithStrategy(options, 'coursier');
  } catch {
    return runSbtClasspathWithStrategy(options, 'sbt-show');
  }
}
