import * as vscode from 'vscode';
import { WorkspaceMode } from './modePresentation';
import { ScalaLiteLogLevel } from './structuredLogCore';

interface ScalaLiteWorkspaceConfig {
  readonly mode?: {
    readonly default?: WorkspaceMode;
  };
  readonly indexedModuleFolder?: string;
  readonly logLevel?: ScalaLiteLogLevel;
}

function getPrimaryWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

function getWorkspaceConfigUri(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, '.vscode', 'scala-lite.json');
}

async function readConfig(folder: vscode.WorkspaceFolder): Promise<ScalaLiteWorkspaceConfig> {
  const configUri = getWorkspaceConfigUri(folder);

  try {
    const raw = await vscode.workspace.fs.readFile(configUri);
    const parsed = JSON.parse(Buffer.from(raw).toString('utf8')) as ScalaLiteWorkspaceConfig;
    return parsed;
  } catch {
    return {};
  }
}

async function writeConfig(folder: vscode.WorkspaceFolder, config: ScalaLiteWorkspaceConfig): Promise<void> {
  const configUri = getWorkspaceConfigUri(folder);
  const parent = vscode.Uri.joinPath(folder.uri, '.vscode');
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(configUri, Buffer.from(`${JSON.stringify(config, null, 2)}\n`, 'utf8'));
}

export async function readDefaultModeFromWorkspaceConfig(): Promise<WorkspaceMode | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  const config = await readConfig(folder);
  return config.mode?.default;
}

export async function writeIndexedModuleFolderToWorkspaceConfig(relativePath: string): Promise<void> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return;
  }

  const existing = await readConfig(folder);
  await writeConfig(folder, {
    ...existing,
    indexedModuleFolder: relativePath
  });
}

export async function readLogLevelFromWorkspaceConfig(): Promise<ScalaLiteLogLevel | undefined> {
  const folder = getPrimaryWorkspaceFolder();
  if (!folder) {
    return undefined;
  }

  const config = await readConfig(folder);
  return config.logLevel;
}