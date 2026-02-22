import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';
import { executeBuildCommand } from './buildCommandExecutor';
import { ensureScalaLiteCacheDir, getScalaLiteCacheUri } from './scalaLiteCache';

export interface MavenModule {
  readonly artifactId: string;
  readonly groupId: string;
  readonly version: string;
  readonly path: string;
  readonly packaging: string;
  readonly hasScala: boolean;
}

interface MavenPomProject {
  readonly artifactId?: string;
  readonly groupId?: string;
  readonly version?: string;
  readonly packaging?: string;
  readonly parent?: {
    readonly groupId?: string;
    readonly version?: string;
  };
  readonly modules?: {
    readonly module?: string | readonly string[];
  };
}

interface MavenPom {
  readonly project?: MavenPomProject;
}

export interface ResolveMavenClasspathOptions {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly module: MavenModule;
  readonly includeTestScope: boolean;
  readonly profiles: readonly string[];
  readonly extraArgs: readonly string[];
  readonly wrapperPathOverride?: string;
  readonly timeoutMs: number;
  readonly cancellationToken: vscode.CancellationToken;
  readonly onOutput?: (line: string) => void;
}

export interface MavenClasspathResult {
  readonly module: MavenModule;
  readonly jars: readonly string[];
  readonly outputDirs: readonly string[];
  readonly cacheFilePath: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: true
});

function toArray(value: string | readonly string[] | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value;
  }

  return [String(value)];
}

function hasScalaArtifactHint(artifactId: string): boolean {
  return /(_2\.1[23]|_3|scala)/i.test(artifactId);
}

export function parseMavenPomXml(xml: string): MavenPom {
  const stripped = xml.replace(/^\uFEFF/, '');
  return parser.parse(stripped) as MavenPom;
}

async function readPomProject(pomPath: string): Promise<MavenPomProject | undefined> {
  const content = await fs.readFile(pomPath, 'utf8');
  return parseMavenPomXml(content).project;
}

function normalizeRelativePath(workspaceRoot: string, dirPath: string): string {
  const relative = path.relative(workspaceRoot, dirPath);
  if (!relative || relative === '') {
    return '.';
  }

  return relative.split(path.sep).join('/');
}

export async function discoverMavenModules(workspaceFolder: vscode.WorkspaceFolder): Promise<readonly MavenModule[]> {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const visited = new Set<string>();
  const modules = new Map<string, MavenModule>();

  const visitPom = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) {
      return;
    }

    const normalizedDirectory = path.resolve(directory);
    if (visited.has(normalizedDirectory)) {
      return;
    }

    visited.add(normalizedDirectory);
    const pomPath = path.join(normalizedDirectory, 'pom.xml');
    let project: MavenPomProject | undefined;

    try {
      project = await readPomProject(pomPath);
    } catch {
      return;
    }

    if (!project) {
      return;
    }

    const relativePath = normalizeRelativePath(workspaceRoot, normalizedDirectory);
    const artifactId = String(project.artifactId ?? path.basename(normalizedDirectory) ?? 'module');
    const groupId = String(project.groupId ?? project.parent?.groupId ?? '');
    const version = String(project.version ?? project.parent?.version ?? '');
    const packaging = String(project.packaging ?? 'jar');

    modules.set(relativePath, {
      artifactId,
      groupId,
      version,
      packaging,
      path: relativePath,
      hasScala: hasScalaArtifactHint(artifactId)
    });

    const childModules = toArray(project.modules?.module)
      .map((entry) => String(entry).trim())
      .filter((entry) => entry.length > 0);

    await Promise.all(childModules.map(async (relativeModulePath) => {
      const childDirectory = path.resolve(normalizedDirectory, relativeModulePath);
      await visitPom(childDirectory, depth + 1);
    }));
  };

  await visitPom(workspaceRoot, 0);

  if (modules.size === 0) {
    return [];
  }

  return Array.from(modules.values())
    .sort((left, right) => {
      const leftDepth = left.path === '.' ? 0 : left.path.split('/').length;
      const rightDepth = right.path === '.' ? 0 : right.path.split('/').length;
      if (leftDepth !== rightDepth) {
        return leftDepth - rightDepth;
      }

      return left.path.localeCompare(right.path);
    });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveMavenExecutable(workspaceRoot: string, wrapperPathOverride: string | undefined): Promise<string> {
  if (wrapperPathOverride && wrapperPathOverride.trim().length > 0) {
    const customPath = path.isAbsolute(wrapperPathOverride)
      ? wrapperPathOverride
      : path.join(workspaceRoot, wrapperPathOverride);
    return customPath;
  }

  const wrapperCandidates = process.platform === 'win32'
    ? ['mvnw.cmd', 'mvnw']
    : ['mvnw'];

  for (const wrapper of wrapperCandidates) {
    const candidate = path.join(workspaceRoot, wrapper);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return 'mvn';
}

function parseClasspathFile(content: string): readonly string[] {
  return content
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

async function runBuildClasspathGoal(
  executable: string,
  workspaceRoot: string,
  modulePath: string,
  scope: 'compile' | 'test',
  profiles: readonly string[],
  extraArgs: readonly string[],
  timeoutMs: number,
  cancellationToken: vscode.CancellationToken,
  outputFilePath: string,
  onOutput?: (line: string) => void
): Promise<readonly string[]> {
  const args: string[] = [
    'dependency:build-classpath',
    `-DincludeScope=${scope}`,
    `-Dmdep.outputFile=${outputFilePath}`
  ];

  if (modulePath !== '.') {
    args.push('-pl', modulePath);
  }

  if (profiles.length > 0) {
    args.push(`-P${profiles.join(',')}`);
  }

  args.push(...extraArgs);

  const result = await executeBuildCommand({
    command: executable,
    args,
    cwd: workspaceRoot,
    timeoutMs,
    cancellationToken,
    onStdout: onOutput,
    onStderr: onOutput
  });

  if (result.wasCancelled) {
    throw new Error('Classpath sync cancelled.');
  }

  if (result.timedOut) {
    throw new Error(`Maven command timed out after ${timeoutMs}ms.`);
  }

  if (result.exitCode !== 0) {
    const outputExcerpt = result.combinedOutput.split(/\r?\n/).slice(-8).join('\n').trim();
    throw new Error(outputExcerpt.length > 0 ? outputExcerpt : `Maven command failed with exit code ${result.exitCode}.`);
  }

  const content = await fs.readFile(outputFilePath, 'utf8');
  return parseClasspathFile(content);
}

function buildClasspathCacheFileName(modulePath: string): string {
  const hash = crypto
    .createHash('sha1')
    .update(modulePath)
    .digest('hex')
    .slice(0, 12);
  return `classpath-${hash}.json`;
}

async function writeClasspathCache(
  workspaceFolder: vscode.WorkspaceFolder,
  module: MavenModule,
  jars: readonly string[],
  outputDirs: readonly string[],
  profiles: readonly string[],
  includeTestScope: boolean
): Promise<string> {
  await ensureScalaLiteCacheDir(workspaceFolder);
  const cacheRoot = getScalaLiteCacheUri(workspaceFolder);
  if (!cacheRoot) {
    throw new Error('Workspace root unavailable for classpath cache.');
  }

  const cacheFileName = buildClasspathCacheFileName(module.path);
  const cacheUri = vscode.Uri.joinPath(cacheRoot, cacheFileName);
  const payload = {
    version: 1,
    buildTool: 'maven',
    module: module.artifactId,
    modulePath: module.path,
    resolvedAt: new Date().toISOString(),
    scope: includeTestScope ? 'compile+test' : 'compile',
    jars,
    outputDirs,
    mavenProfiles: [...profiles]
  };

  await vscode.workspace.fs.writeFile(cacheUri, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8'));
  return cacheUri.fsPath;
}

export async function resolveMavenClasspath(options: ResolveMavenClasspathOptions): Promise<MavenClasspathResult> {
  const workspaceRoot = options.workspaceFolder.uri.fsPath;
  const moduleAbsolutePath = options.module.path === '.'
    ? workspaceRoot
    : path.join(workspaceRoot, options.module.path);
  const executable = await resolveMavenExecutable(workspaceRoot, options.wrapperPathOverride);

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'scala-lite-maven-'));
  try {
    const compileOutputPath = path.join(tempDirectory, 'compile-classpath.txt');
    const compileClasspath = await runBuildClasspathGoal(
      executable,
      workspaceRoot,
      options.module.path,
      'compile',
      options.profiles,
      options.extraArgs,
      options.timeoutMs,
      options.cancellationToken,
      compileOutputPath,
      options.onOutput
    );

    let testClasspath: readonly string[] = [];
    if (options.includeTestScope) {
      const testOutputPath = path.join(tempDirectory, 'test-classpath.txt');
      testClasspath = await runBuildClasspathGoal(
        executable,
        workspaceRoot,
        options.module.path,
        'test',
        options.profiles,
        options.extraArgs,
        options.timeoutMs,
        options.cancellationToken,
        testOutputPath,
        options.onOutput
      );
    }

    const jars = unique([...compileClasspath, ...testClasspath]);
    const outputDirs = unique([
      path.join(moduleAbsolutePath, 'target', 'classes'),
      ...(options.includeTestScope ? [path.join(moduleAbsolutePath, 'target', 'test-classes')] : [])
    ]);

    const cacheFilePath = await writeClasspathCache(
      options.workspaceFolder,
      options.module,
      jars,
      outputDirs,
      options.profiles,
      options.includeTestScope
    );

    return {
      module: options.module,
      jars,
      outputDirs,
      cacheFilePath
    };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}
