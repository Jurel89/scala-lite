import * as vscode from 'vscode';
import {
  BuildTool,
  DetectionSignals as _DetectionSignals,
  inferBuildToolFromSignals
} from './buildToolInference';

export interface BuildToolDetectionResult {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly buildTool: BuildTool;
}

export type ClasspathProvider = 'maven' | 'sbt' | 'none';

export interface ClasspathProviderDetectionResult {
  readonly provider: ClasspathProvider;
  readonly hasMavenWrapper: boolean;
  readonly hasSbtWrapper: boolean;
  readonly bothDetected: boolean;
}


async function readTextFiles(workspace: typeof vscode.workspace, uris: readonly vscode.Uri[]): Promise<string[]> {
  const contents = await Promise.all(
    uris.map(async (uri) => {
      const raw = await workspace.fs.readFile(uri);
      return Buffer.from(raw).toString('utf8');
    })
  );

  return contents;
}

async function findExists(
  workspace: typeof vscode.workspace,
  folder: vscode.WorkspaceFolder,
  pattern: string,
  maxResults = 1
): Promise<boolean> {
  const matches = await workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, maxResults);
  return matches.length > 0;
}

async function findTextSnippets(
  workspace: typeof vscode.workspace,
  folder: vscode.WorkspaceFolder,
  pattern: string,
  maxResults: number
): Promise<string[]> {
  const uris = await workspace.findFiles(new vscode.RelativePattern(folder, pattern), undefined, maxResults);
  if (uris.length === 0) {
    return [];
  }

  return readTextFiles(workspace, uris);
}

export async function detectBuildToolForFolder(
  folder: vscode.WorkspaceFolder,
  workspace: typeof vscode.workspace = vscode.workspace
): Promise<BuildToolDetectionResult> {
  const [
    hasSbtRoot,
    hasSbtImmediateChild,
    hasSbtProjectBuildPropertiesRoot,
    hasSbtProjectBuildPropertiesImmediateChild,
    hasMillRoot,
    hasScalaBuildDirectoryRoot,
    scalaRootSnippets,
    scalaImmediateChildSnippets,
    pomRootSnippets,
    pomImmediateChildSnippets,
    gradleRootSnippets,
    gradleImmediateChildSnippets,
    gradleKtsRootSnippets,
    gradleKtsImmediateChildSnippets
  ] = await Promise.all([
    findExists(workspace, folder, 'build.sbt'),
    findExists(workspace, folder, '*/build.sbt'),
    findExists(workspace, folder, 'project/build.properties'),
    findExists(workspace, folder, '*/project/build.properties'),
    findExists(workspace, folder, 'build.sc'),
    findExists(workspace, folder, '.scala-build/**'),
    findTextSnippets(workspace, folder, '*.scala', 20),
    findTextSnippets(workspace, folder, '*/*.scala', 20),
    findTextSnippets(workspace, folder, 'pom.xml', 5),
    findTextSnippets(workspace, folder, '*/pom.xml', 5),
    findTextSnippets(workspace, folder, 'build.gradle', 5),
    findTextSnippets(workspace, folder, '*/build.gradle', 5),
    findTextSnippets(workspace, folder, 'build.gradle.kts', 5),
    findTextSnippets(workspace, folder, '*/build.gradle.kts', 5)
  ]);

  const buildTool = inferBuildToolFromSignals({
    hasSbtRoot,
    hasSbtImmediateChild,
    hasSbtProjectBuildPropertiesRoot,
    hasSbtProjectBuildPropertiesImmediateChild,
    hasMillRoot,
    hasScalaBuildDirectoryRoot,
    scalaSourceSnippets: [...scalaRootSnippets, ...scalaImmediateChildSnippets],
    mavenPomSnippets: [...pomRootSnippets, ...pomImmediateChildSnippets],
    gradleBuildSnippets: [...gradleRootSnippets, ...gradleImmediateChildSnippets, ...gradleKtsRootSnippets, ...gradleKtsImmediateChildSnippets]
  });

  return {
    workspaceFolder: folder,
    buildTool
  };
}

export async function detectBuildToolsForWorkspace(
  folders: readonly vscode.WorkspaceFolder[],
  workspace: typeof vscode.workspace = vscode.workspace
): Promise<BuildToolDetectionResult[]> {
  const results = await Promise.all(folders.map((folder) => detectBuildToolForFolder(folder, workspace)));
  return results;
}

export class BuildToolDetectionSession {
  private readonly cache = new Map<string, BuildToolDetectionResult>();

  public async detectAll(
    folders: readonly vscode.WorkspaceFolder[],
    force: boolean,
    workspace: typeof vscode.workspace = vscode.workspace
  ): Promise<BuildToolDetectionResult[]> {
    const detected = await Promise.all(
      folders.map(async (folder) => {
        const cacheKey = folder.uri.toString();
        const cached = this.cache.get(cacheKey);
        if (!force && cached) {
          return cached;
        }

        const result = await detectBuildToolForFolder(folder, workspace);
        this.cache.set(cacheKey, result);
        return result;
      })
    );

    return detected;
  }
}

export interface ClasspathProviderChoiceOptions {
  readonly preferred?: 'maven' | 'sbt' | 'auto';
  readonly promptUser?: (options: readonly ClasspathProvider[]) => Promise<ClasspathProvider | undefined>;
}

export function chooseClasspathProvider(
  hasMavenProject: boolean,
  hasSbtProject: boolean,
  options?: ClasspathProviderChoiceOptions
): Promise<ClasspathProvider> {
  const preferred = options?.preferred ?? 'auto';
  if (hasMavenProject && hasSbtProject) {
    if (preferred === 'maven' || preferred === 'sbt') {
      return Promise.resolve(preferred);
    }

    if (options?.promptUser) {
      return options.promptUser(['sbt', 'maven']).then((picked) => picked ?? 'sbt');
    }

    return Promise.resolve('sbt');
  }

  if (hasSbtProject) {
    return Promise.resolve('sbt');
  }

  if (hasMavenProject) {
    return Promise.resolve('maven');
  }

  return Promise.resolve('none');
}

export async function detectClasspathProvider(
  folder: vscode.WorkspaceFolder,
  options?: ClasspathProviderChoiceOptions,
  workspace: typeof vscode.workspace = vscode.workspace
): Promise<ClasspathProviderDetectionResult> {
  const [
    hasSbtBuild,
    hasMavenPom,
    hasSbtWrapperUnix,
    hasSbtWrapperBat,
    hasSbtWrapperCmd,
    hasMavenWrapperUnix,
    hasMavenWrapperCmd
  ] = await Promise.all([
    findExists(workspace, folder, 'build.sbt'),
    findExists(workspace, folder, 'pom.xml'),
    findExists(workspace, folder, 'sbt'),
    findExists(workspace, folder, 'sbt.bat'),
    findExists(workspace, folder, 'sbt.cmd'),
    findExists(workspace, folder, 'mvnw'),
    findExists(workspace, folder, 'mvnw.cmd')
  ]);

  const hasMavenWrapper = hasMavenWrapperUnix || hasMavenWrapperCmd;
  const hasSbtWrapper = hasSbtWrapperUnix || hasSbtWrapperBat || hasSbtWrapperCmd;

  const provider = await chooseClasspathProvider(
    hasMavenPom,
    hasSbtBuild,
    options
  );

  return {
    provider,
    hasMavenWrapper,
    hasSbtWrapper,
    bothDetected: hasMavenPom && hasSbtBuild
  };
}