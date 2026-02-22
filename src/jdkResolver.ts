import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type JdkSource = 'workspace-config' | 'env-java-home' | 'auto-macos' | 'auto-linux' | 'auto-windows' | 'none';

export interface JdkResolutionResult {
  readonly source: JdkSource;
  readonly home?: string;
  readonly jmodsPath?: string;
  readonly rtJarPath?: string;
  readonly availableModules: readonly string[];
  readonly selectedModules: readonly string[];
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function firstExistingPath(paths: readonly string[]): Promise<string | undefined> {
  for (const entry of paths) {
    if (await pathExists(entry)) {
      return entry;
    }
  }

  return undefined;
}

async function listAvailableJmods(jmodsPath: string): Promise<readonly string[]> {
  try {
    const directoryEntries = await fs.readdir(jmodsPath, { withFileTypes: true });
    const entries = directoryEntries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jmod'))
      .map((entry) => entry.name.slice(0, -5));
    return entries.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function detectMacOsJdkHome(): Promise<string | undefined> {
  const javaVirtualMachinesPath = '/Library/Java/JavaVirtualMachines';
  let entries: readonly { name: string; isDirectory(): boolean }[];
  try {
    entries = await fs.readdir(javaVirtualMachinesPath, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const homes = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(javaVirtualMachinesPath, entry.name, 'Contents', 'Home'));

  return firstExistingPath(homes);
}

async function detectLinuxJdkHome(): Promise<string | undefined> {
  const candidates = [
    '/usr/lib/jvm/default-java',
    '/usr/lib/jvm/java-21-openjdk',
    '/usr/lib/jvm/java-17-openjdk',
    '/usr/lib/jvm/java-11-openjdk',
    '/usr/lib/jvm/java-21-openjdk-amd64',
    '/usr/lib/jvm/java-17-openjdk-amd64',
    '/usr/lib/jvm/java-11-openjdk-amd64'
  ];

  return firstExistingPath(candidates);
}

async function detectWindowsJdkHome(): Promise<string | undefined> {
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env['ProgramFiles(x86)'];

  const roots = [programFiles, programFilesX86]
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);

  const candidates = roots.flatMap((root) => [
    path.join(root, 'Java', 'jdk-21'),
    path.join(root, 'Java', 'jdk-17'),
    path.join(root, 'Java', 'jdk-11'),
    path.join(root, 'Eclipse Adoptium', 'jdk-21'),
    path.join(root, 'Eclipse Adoptium', 'jdk-17'),
    path.join(root, 'Eclipse Adoptium', 'jdk-11')
  ]);

  return firstExistingPath(candidates);
}

async function resolveJdkHome(
  workspaceRoot: string,
  workspaceJdkHome: string | undefined
): Promise<{ home?: string; source: JdkSource }> {
  if (workspaceJdkHome && workspaceJdkHome.trim().length > 0) {
    const configuredPath = workspaceJdkHome.trim();
    const normalizedConfiguredPath = path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(workspaceRoot, configuredPath);
    if (await pathExists(normalizedConfiguredPath)) {
      return {
        home: normalizedConfiguredPath,
        source: 'workspace-config'
      };
    }
  }

  const javaHome = process.env.JAVA_HOME;
  if (javaHome && javaHome.trim().length > 0) {
    const normalizedJavaHome = javaHome.trim();
    if (await pathExists(normalizedJavaHome)) {
      return {
        home: normalizedJavaHome,
        source: 'env-java-home'
      };
    }
  }

  if (process.platform === 'darwin') {
    const macHome = await detectMacOsJdkHome();
    if (macHome) {
      return {
        home: macHome,
        source: 'auto-macos'
      };
    }
  }

  if (process.platform === 'linux') {
    const linuxHome = await detectLinuxJdkHome();
    if (linuxHome) {
      return {
        home: linuxHome,
        source: 'auto-linux'
      };
    }
  }

  if (process.platform === 'win32') {
    const windowsHome = await detectWindowsJdkHome();
    if (windowsHome) {
      return {
        home: windowsHome,
        source: 'auto-windows'
      };
    }
  }

  return {
    source: 'none'
  };
}

function filterSelectedModules(
  requestedModules: readonly string[],
  availableModules: readonly string[]
): readonly string[] {
  if (requestedModules.length === 0) {
    return [];
  }

  if (availableModules.length === 0) {
    return requestedModules;
  }

  const available = new Set(availableModules);
  return requestedModules.filter((moduleName) => available.has(moduleName));
}

export async function resolveJdkModules(
  workspaceFolder: vscode.WorkspaceFolder,
  workspaceJdkHome: string | undefined,
  requestedModules: readonly string[]
): Promise<JdkResolutionResult> {
  const jdkHomeResult = await resolveJdkHome(workspaceFolder.uri.fsPath, workspaceJdkHome);
  if (!jdkHomeResult.home) {
    return {
      source: jdkHomeResult.source,
      availableModules: [],
      selectedModules: requestedModules
    };
  }

  const normalizedHome = jdkHomeResult.home;
  const jmodsPath = path.join(normalizedHome, 'jmods');
  const rtJarPath = path.join(normalizedHome, 'jre', 'lib', 'rt.jar');

  const hasJmods = await pathExists(jmodsPath);
  const hasRtJar = await pathExists(rtJarPath);
  const availableModules = hasJmods ? await listAvailableJmods(jmodsPath) : [];
  const selectedModules = filterSelectedModules(requestedModules, availableModules);

  return {
    source: jdkHomeResult.source,
    home: normalizedHome,
    jmodsPath: hasJmods ? jmodsPath : undefined,
    rtJarPath: hasRtJar ? rtJarPath : undefined,
    availableModules,
    selectedModules
  };
}
