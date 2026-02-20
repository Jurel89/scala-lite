import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BuildTool } from './buildToolInference';
import { defaultScalafmtConfContent } from './scalafmtCore';

export const COMMAND_WORKSPACE_DOCTOR = 'scalaLite.runWorkspaceDoctor';

type Severity = 'info' | 'warning' | 'critical';
type DoctorCheckId =
  | 'workspace-size'
  | 'scala-file-count'
  | 'target-size'
  | 'node-modules'
  | 'symlinks'
  | 'generated-sources'
  | 'scalafmt-missing'
  | 'build-tool-missing';

interface DoctorIssue {
  readonly id: DoctorCheckId;
  readonly title: string;
  readonly severity: Severity;
  readonly recommendation: string;
  readonly fixAction?: 'create-scalafmt' | 'open-config' | 'detect-build-tool';
}

interface WorkspaceDoctorFeatureOptions {
  readonly getBuildTool: () => BuildTool;
  readonly getPrioritizedFolderRoots?: () => readonly string[];
  readonly onPrioritizationApplied?: (prioritizedFolderCount: number, totalFolderCount: number) => void;
}

interface FolderFacts {
  readonly workspaceFolder: vscode.WorkspaceFolder;
  readonly hasNodeModules: boolean;
  readonly hasScalafmtConf: boolean;
  readonly targetBytes: number;
  readonly hasGeneratedSources: boolean;
  readonly hasSymlink: boolean;
}

function iconForSeverity(severity: Severity): string {
  if (severity === 'critical') {
    return '🔴';
  }

  if (severity === 'warning') {
    return '⚠️';
  }

  return 'ℹ️';
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function pathExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function collectFolderFacts(workspaceFolder: vscode.WorkspaceFolder): Promise<FolderFacts> {
  const rootPath = workspaceFolder.uri.fsPath;
  const nodeModulesUri = vscode.Uri.file(path.join(rootPath, 'node_modules'));
  const scalafmtUri = vscode.Uri.file(path.join(rootPath, '.scalafmt.conf'));
  const targetPath = path.join(rootPath, 'target');

  const [hasNodeModules, hasScalafmtConf, targetBytes, scan] = await Promise.all([
    pathExists(nodeModulesUri),
    pathExists(scalafmtUri),
    getDirectorySizeSafe(targetPath, 10_000),
    scanWorkspaceRoot(rootPath)
  ]);

  return {
    workspaceFolder,
    hasNodeModules,
    hasScalafmtConf,
    targetBytes,
    hasGeneratedSources: scan.hasGeneratedSources,
    hasSymlink: scan.hasSymlink
  };
}

async function getDirectorySizeSafe(
  directoryPath: string,
  maxEntries: number,
  token?: vscode.CancellationToken
): Promise<number> {
  let total = 0;
  let visitedEntries = 0;

  const walk = async (current: string): Promise<void> => {
    if (visitedEntries >= maxEntries || token?.isCancellationRequested) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visitedEntries >= maxEntries || token?.isCancellationRequested) {
        break;
      }

      visitedEntries += 1;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }

      try {
        const stat = await fs.stat(absolute);
        total += stat.size;
      } catch {
      }
    }
  };

  await walk(directoryPath);
  return total;
}

async function scanWorkspaceRoot(rootPath: string): Promise<{ hasGeneratedSources: boolean; hasSymlink: boolean }> {
  const generatedHints = ['generated', 'src_managed', 'target/scala-', 'build/generated'];
  let hasGeneratedSources = false;
  let hasSymlink = false;

  const walk = async (current: string, depth: number, token?: vscode.CancellationToken): Promise<void> => {
    if (depth > 4 || (hasGeneratedSources && hasSymlink) || token?.isCancellationRequested) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>;
    try {
      entries = await fs.readdir(current, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(rootPath, absolute).replace(/\\/g, '/');

      if (entry.isSymbolicLink()) {
        hasSymlink = true;
      }

      if (generatedHints.some((hint) => relative.includes(hint))) {
        hasGeneratedSources = true;
      }

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(absolute, depth + 1, token);
      }

      if (hasGeneratedSources && hasSymlink) {
        break;
      }
    }
  };

  await walk(rootPath, 0);
  return { hasGeneratedSources, hasSymlink };
}

function renderReport(issues: readonly DoctorIssue[]): string {
  if (issues.length === 0) {
    return 'Scala Lite Workspace Doctor: no issues detected.';
  }

  return [
    'Scala Lite Workspace Doctor Report',
    ...issues.map((issue) => `- ${iconForSeverity(issue.severity)} ${issue.title}: ${issue.recommendation}`)
  ].join('\n');
}

function renderWebviewHtml(panel: vscode.WebviewPanel, issues: readonly DoctorIssue[], report: string): string {
  const nonce = String(Date.now());
  const serializedIssues = JSON.stringify(issues);
  const escapedReport = report.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Scala Lite Workspace Doctor</title>
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
    h2 { margin-top: 0; }
    .item { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .title { font-weight: 600; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
    pre { white-space: pre-wrap; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; }
  </style>
</head>
<body>
  <h2>Scala Lite Workspace Doctor</h2>
  <div class="toolbar">
    <button id="copy-report">Copy Report</button>
    <button id="refresh" class="secondary">Refresh</button>
  </div>
  <div id="results"></div>
  <pre>${escapedReport}</pre>
  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    const issues = ${serializedIssues};
    const results = document.getElementById('results');

    for (const issue of issues) {
      const item = document.createElement('div');
      item.className = 'item';
      const fixButton = issue.fixAction
        ? '<button data-fix="' + issue.fixAction + '" data-id="' + issue.id + '">Fix</button>'
        : '';
      item.innerHTML =
        '<div class="header">' +
          '<div class="title">' + issue.title + '</div>' +
          fixButton +
        '</div>' +
        '<div>' + issue.recommendation + '</div>';
      results.appendChild(item);
    }

    document.getElementById('copy-report')?.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'copyReport' });
    });

    document.getElementById('refresh')?.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'refresh' });
    });

    results.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLButtonElement)) {
        return;
      }

      const fixAction = target.dataset.fix;
      const issueId = target.dataset.id;
      if (!fixAction || !issueId) {
        return;
      }

      vscodeApi.postMessage({ type: 'fix', fixAction, issueId });
    });
  </script>
</body>
</html>`;
}

async function buildDoctorIssues(
  options: WorkspaceDoctorFeatureOptions,
  token?: vscode.CancellationToken
): Promise<DoctorIssue[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return [];
  }

  if (token?.isCancellationRequested) {
    return [];
  }

  const prioritizedFolderRoots = new Set(
    (options.getPrioritizedFolderRoots?.() ?? []).map((entry) => path.resolve(entry))
  );
  const orderedFolders = [...folders].sort((left, right) => {
    const leftPriority = prioritizedFolderRoots.has(path.resolve(left.uri.fsPath)) ? 0 : 1;
    const rightPriority = prioritizedFolderRoots.has(path.resolve(right.uri.fsPath)) ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return left.uri.fsPath.localeCompare(right.uri.fsPath);
  });
  const prioritizedFolderCount = orderedFolders.filter((folder) => prioritizedFolderRoots.has(path.resolve(folder.uri.fsPath))).length;
  options.onPrioritizationApplied?.(prioritizedFolderCount, orderedFolders.length);

  const [allFiles, scalaFiles, folderFacts] = await Promise.all([
    vscode.workspace.findFiles('**/*', undefined, 10_001),
    vscode.workspace.findFiles('**/*.{scala,sbt}', undefined, 5_001),
    Promise.all(orderedFolders.map(async (folder) => {
      const rootPath = folder.uri.fsPath;
      const nodeModulesUri = vscode.Uri.file(path.join(rootPath, 'node_modules'));
      const scalafmtUri = vscode.Uri.file(path.join(rootPath, '.scalafmt.conf'));
      const targetPath = path.join(rootPath, 'target');

      const [hasNodeModules, hasScalafmtConf, targetBytes, scan] = await Promise.all([
        pathExists(nodeModulesUri),
        pathExists(scalafmtUri),
        getDirectorySizeSafe(targetPath, 10_000, token),
        scanWorkspaceRoot(rootPath)
      ]);

      return {
        workspaceFolder: folder,
        hasNodeModules,
        hasScalafmtConf,
        targetBytes,
        hasGeneratedSources: scan.hasGeneratedSources,
        hasSymlink: scan.hasSymlink
      } as FolderFacts;
    }))
  ]);

  if (token?.isCancellationRequested) {
    return [];
  }

  const issues: DoctorIssue[] = [];

  if (allFiles.length >= 10_001) {
    issues.push({
      id: 'workspace-size',
      title: `${iconForSeverity('warning')} Large workspace`,
      severity: 'warning',
      recommendation: 'Large workspace. Recommend Mode A or B.'
    });
  }

  if (scalaFiles.length >= 5_001) {
    issues.push({
      id: 'scala-file-count',
      title: `${iconForSeverity('warning')} High Scala file count`,
      severity: 'warning',
      recommendation: 'Many Scala files. Module-scoped indexing recommended.'
    });
  }

  const targetSize = folderFacts.reduce((sum, facts) => sum + facts.targetBytes, 0);
  if (targetSize > 500 * 1024 * 1024) {
    issues.push({
      id: 'target-size',
      title: `${iconForSeverity('warning')} Large target folder`,
      severity: 'warning',
      recommendation: `Large build output (${formatBytes(targetSize)}). Consider running clean.`
    });
  }

  if (folderFacts.some((facts) => facts.hasNodeModules)) {
    issues.push({
      id: 'node-modules',
      title: `${iconForSeverity('info')} node_modules detected`,
      severity: 'info',
      recommendation: 'Ensure ignore rules active.'
    });
  }

  if (folderFacts.some((facts) => facts.hasSymlink)) {
    issues.push({
      id: 'symlinks',
      title: `${iconForSeverity('warning')} Symlinks detected`,
      severity: 'warning',
      recommendation: 'Symlinks may cause duplicate scanning.'
    });
  }

  if (folderFacts.some((facts) => facts.hasGeneratedSources)) {
    issues.push({
      id: 'generated-sources',
      title: `${iconForSeverity('info')} Generated sources detected`,
      severity: 'info',
      recommendation: 'Consider adding to ignorePatterns.',
      fixAction: 'open-config'
    });
  }

  if (folderFacts.some((facts) => !facts.hasScalafmtConf)) {
    issues.push({
      id: 'scalafmt-missing',
      title: `${iconForSeverity('warning')} Missing .scalafmt.conf`,
      severity: 'warning',
      recommendation: 'No Scalafmt config found.',
      fixAction: 'create-scalafmt'
    });
  }

  if (options.getBuildTool() === 'none') {
    issues.push({
      id: 'build-tool-missing',
      title: `${iconForSeverity('critical')} Build tool not detected`,
      severity: 'critical',
      recommendation: 'Run/Test features disabled.',
      fixAction: 'detect-build-tool'
    });
  }

  return issues;
}

async function createScalafmtConfIfMissing(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return;
  }

  for (const folder of folders) {
    const uri = vscode.Uri.joinPath(folder.uri, '.scalafmt.conf');
    if (await pathExists(uri)) {
      continue;
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(defaultScalafmtConfContent(), 'utf8'));
  }
}

export function registerWorkspaceDoctorFeature(options: WorkspaceDoctorFeatureOptions): vscode.Disposable[] {
  const command = vscode.commands.registerCommand(COMMAND_WORKSPACE_DOCTOR, async () => {
    const panel = vscode.window.createWebviewPanel(
      'scalaLite.workspaceDoctor',
      vscode.l10n.t('Scala Lite: Workspace Doctor'),
      vscode.ViewColumn.Active,
      { enableScripts: true }
    );

    const refresh = async (token?: vscode.CancellationToken): Promise<void> => {
      const issues = await buildDoctorIssues(options, token);
      if (token?.isCancellationRequested) {
        vscode.window.setStatusBarMessage(vscode.l10n.t('Workspace Doctor cancelled.'), 2500);
        return;
      }

      const report = renderReport(issues);
      panel.webview.html = renderWebviewHtml(panel, issues, report);
    };

    panel.webview.onDidReceiveMessage(async (message: { type?: string; fixAction?: string }) => {
      if (message.type === 'copyReport') {
        const issues = await buildDoctorIssues(options);
        await vscode.env.clipboard.writeText(renderReport(issues));
        vscode.window.setStatusBarMessage(vscode.l10n.t('Workspace Doctor report copied.'), 2500);
        return;
      }

      if (message.type === 'refresh') {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Scala Lite: Workspace Doctor',
            cancellable: true
          },
          async (_progress, token) => refresh(token)
        );
        return;
      }

      if (message.type === 'fix' && message.fixAction) {
        if (message.fixAction === 'create-scalafmt') {
          await createScalafmtConfIfMissing();
          vscode.window.showInformationMessage(vscode.l10n.t('Created missing .scalafmt.conf file(s).'));
        }

        if (message.fixAction === 'open-config') {
          await vscode.commands.executeCommand('scalaLite.openConfiguration');
        }

        if (message.fixAction === 'detect-build-tool') {
          await vscode.commands.executeCommand('scalaLite.reDetectBuildTool');
        }

        await refresh();
      }
    });

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Scala Lite: Workspace Doctor',
        cancellable: true
      },
      async (_progress, token) => refresh(token)
    );
  });

  return [command];
}
