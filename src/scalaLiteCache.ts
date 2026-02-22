import * as vscode from 'vscode';

const SCALA_LITE_CACHE_DIR = '.scala-lite';
const GITIGNORE_CONTENT = '*\n';

export interface ScalaLiteCacheSummary {
  readonly exists: boolean;
  readonly totalBytes: number;
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
  await Promise.all(entries.map(async ([name]) => {
    const childUri = vscode.Uri.joinPath(cacheUri, name);
    await vscode.workspace.fs.delete(childUri, { recursive: true, useTrash: false });
  }));

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
