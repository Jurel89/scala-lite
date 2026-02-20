import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import {
  defaultScalafmtConfContent,
  resolveScalafmtResolution,
  runScalafmtWithTimeout,
  ScalafmtConfig
} from './scalafmtCore';
import { StructuredLogger } from './structuredLogger';
import {
  readBudgetConfigFromWorkspaceConfig,
  readFormatterConfigFromWorkspaceConfig
} from './workspaceConfig';

async function readWorkspaceScalafmtConfig(folder: vscode.WorkspaceFolder): Promise<ScalafmtConfig> {
  const owningFolder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.toString() === folder.uri.toString());
  if (!owningFolder) {
    return {};
  }

  return readFormatterConfigFromWorkspaceConfig();
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function hasGlobalScalafmtBinary(cwd: string): Promise<boolean> {
  const probe = spawn('scalafmt', ['--version'], { shell: true, cwd });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      try {
        probe.kill();
      } catch {
      }
      resolve(false);
    }, 1500);

    probe.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    probe.on('close', (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function ensureScalafmtConf(folder: vscode.WorkspaceFolder, logger: StructuredLogger): Promise<boolean> {
  const confUri = vscode.Uri.joinPath(folder.uri, '.scalafmt.conf');
  if (await fileExists(confUri)) {
    return true;
  }

  const action = await vscode.window.showWarningMessage(
    vscode.l10n.t('No .scalafmt.conf found.'),
    vscode.l10n.t('Create default'),
    vscode.l10n.t('Ignore')
  );

  if (action !== vscode.l10n.t('Create default')) {
    logger.warn('FORMAT', 'Formatting skipped: .scalafmt.conf missing and user ignored creation.');
    return false;
  }

  await vscode.workspace.fs.writeFile(confUri, Buffer.from(defaultScalafmtConfContent(), 'utf8'));
  logger.info('FORMAT', 'Created default .scalafmt.conf in workspace root.');
  return true;
}

async function runResolvedScalafmt(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
  token?: vscode.CancellationToken
): Promise<{ status: 'ok' | 'timeout' | 'error'; stdout?: string; error?: string }> {
  let child: ReturnType<typeof spawn> | undefined;

  const cancellation = token?.onCancellationRequested(() => {
    try {
      child?.kill();
    } catch {
    }
  });

  const result = await runScalafmtWithTimeout(async () => {
    return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      child = spawn(command, args, { shell: true, cwd });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });

      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });

      child.on('error', (error) => {
        resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), exitCode: 1 });
      });

      child.on('close', (exitCode) => {
        resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
      });

      child.stdin?.write(input);
      child.stdin?.end();
    });
  }, timeoutMs);

  if (result.status === 'timeout') {
    try {
      child?.kill();
    } catch {
    }
  }

  cancellation?.dispose();

  if (token?.isCancellationRequested) {
    return { status: 'error', error: vscode.l10n.t('Scala Lite operation cancelled.') };
  }

  return result;
}

export function registerScalafmtFeature(logger: StructuredLogger): vscode.Disposable[] {
  const formattingProvider: vscode.DocumentFormattingEditProvider = {
    async provideDocumentFormattingEdits(document, _options, token) {
      if (!document.fileName.endsWith('.scala') && !document.fileName.endsWith('.sbt')) {
        return [];
      }

      if (token.isCancellationRequested) {
        return [];
      }

      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      if (!folder) {
        return [];
      }

      const config = await readWorkspaceScalafmtConfig(folder);
      const budgets = await readBudgetConfigFromWorkspaceConfig();
      const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : budgets.formatterTimeMs;

      const confReady = await ensureScalafmtConf(folder, logger);
      if (!confReady) {
        return [];
      }

      const workspaceBinUri = vscode.Uri.joinPath(folder.uri, '.scalafmt-bin');
      const resolution = resolveScalafmtResolution({
        workspaceRoot: folder.uri.fsPath,
        formatterPath: config.path,
        hasWorkspaceBinary: await fileExists(workspaceBinUri),
        hasGlobalBinary: await hasGlobalScalafmtBinary(folder.uri.fsPath),
        useDocker: Boolean(config.useDocker),
        filePath: document.uri.fsPath,
        workspaceRelativeFilePath: vscode.workspace.asRelativePath(document.uri, false)
      });

      if (!resolution) {
        logger.warn('FORMAT', 'No scalafmt binary resolved; formatting skipped.');
        return [];
      }

      const startedAt = Date.now();
      const result = await runResolvedScalafmt(
        resolution.command,
        resolution.args,
        document.getText(),
        folder.uri.fsPath,
        timeoutMs,
        token
      );

      if (token.isCancellationRequested) {
        logger.info('FORMAT', 'Scalafmt operation cancelled by user.', Date.now() - startedAt);
        return [];
      }

      if (result.status === 'timeout') {
        const seconds = Math.round(timeoutMs / 1000);
        const message = vscode.l10n.t('Scalafmt timed out after {0}s. File unchanged.', String(seconds));
        vscode.window.showWarningMessage(message);
        logger.warn('FORMAT', message, Date.now() - startedAt);
        return [];
      }

      if (result.status === 'error' || typeof result.stdout !== 'string') {
        logger.error('FORMAT', `Scalafmt error: ${result.error ?? 'Unknown error'}`, Date.now() - startedAt);
        return [];
      }

      if (result.stdout === document.getText()) {
        logger.info('FORMAT', 'Scalafmt completed with no changes.', Date.now() - startedAt);
        return [];
      }

      const end = document.lineAt(document.lineCount - 1).range.end;
      const fullRange = new vscode.Range(new vscode.Position(0, 0), end);
      logger.info('FORMAT', 'Scalafmt completed successfully.', Date.now() - startedAt);
      return [vscode.TextEdit.replace(fullRange, result.stdout)];
    }
  };

  const providerDisposable = vscode.languages.registerDocumentFormattingEditProvider(
    [{ language: 'scala' }, { pattern: '**/*.sbt' }],
    formattingProvider
  );

  const willSaveDisposable = vscode.workspace.onWillSaveTextDocument(async (event) => {
    const folder = vscode.workspace.getWorkspaceFolder(event.document.uri);
    if (!folder) {
      return;
    }

    const config = await readWorkspaceScalafmtConfig(folder);
    if (!config.formatOnSave) {
      return;
    }

    event.waitUntil(
      Promise.resolve(
        formattingProvider.provideDocumentFormattingEdits(
          event.document,
          { tabSize: 2, insertSpaces: true },
          new vscode.CancellationTokenSource().token
        )
      ).then((edits) => edits ?? [])
    );
  });

  return [providerDisposable, willSaveDisposable];
}