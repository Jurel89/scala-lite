import { spawn } from 'node:child_process';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  parseScalafixOutputLine,
  resolveScalafixResolution,
  runScalafixWithTimeout,
  ScalafixConfig,
  ScalafixIssue
} from './scalafixCore';
import { StructuredLogger } from './structuredLogger';
import {
  readBudgetConfigFromWorkspaceConfig,
  readLinterConfigFromWorkspaceConfig
} from './workspaceConfig';

export const COMMAND_RUN_SCALAFIX = 'scalaLite.runScalafix';
export const COMMAND_APPLY_SCALAFIX_FIX = 'scalaLite.applyScalafixFix';

interface ScalafixFixState {
  readonly updatedText: string;
  readonly issues: readonly ScalafixIssue[];
}

interface ApplyScalafixArgs {
  readonly documentUri: string;
}

class ScalafixCodeLensProvider implements vscode.CodeLensProvider {
  public constructor(private readonly fixStateByDocument: Map<string, ScalafixFixState>) {}

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const state = this.fixStateByDocument.get(document.uri.toString());
    if (!state) {
      return [];
    }

    const fixableIssues = state.issues.filter((issue) => issue.fixable);
    if (fixableIssues.length === 0) {
      return [];
    }

    return fixableIssues.map((issue) => {
      const line = Math.max(0, issue.line - 1);
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, {
        title: '🔧 Fix',
        command: COMMAND_APPLY_SCALAFIX_FIX,
        arguments: [{ documentUri: document.uri.toString() } as ApplyScalafixArgs]
      });
    });
  }
}

async function readWorkspaceScalafixConfig(folder: vscode.WorkspaceFolder): Promise<ScalafixConfig> {
  const owningFolder = vscode.workspace.workspaceFolders?.find((entry) => entry.uri.toString() === folder.uri.toString());
  if (!owningFolder) {
    return {};
  }

  return readLinterConfigFromWorkspaceConfig();
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function hasGlobalScalafixBinary(cwd: string): Promise<boolean> {
  const probe = spawn('scalafix', ['--version'], { shell: true, cwd });

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

function normalizeIssuePath(issueFilePath: string, folder: vscode.WorkspaceFolder): string {
  if (path.isAbsolute(issueFilePath)) {
    return issueFilePath;
  }

  return path.resolve(folder.uri.fsPath, issueFilePath);
}

async function runResolvedScalafix(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number
): Promise<{ status: 'ok' | 'timeout' | 'error'; stdout?: string; stderr?: string; error?: string }> {
  let child: ReturnType<typeof spawn> | undefined;

  const result = await runScalafixWithTimeout(async () => {
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

  return result;
}

function buildDiagnostics(
  issues: readonly ScalafixIssue[],
  document: vscode.TextDocument,
  folder: vscode.WorkspaceFolder
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const issue of issues) {
    const issuePath = normalizeIssuePath(issue.filePath, folder);
    if (path.resolve(issuePath) !== path.resolve(document.uri.fsPath)) {
      continue;
    }

    const line = Math.max(0, issue.line - 1);
    const column = Math.max(0, issue.column - 1);
    const endColumn = Math.min(column + 1, document.lineAt(Math.min(line, document.lineCount - 1)).range.end.character);
    const range = new vscode.Range(line, column, line, endColumn);
    const diagnostic = new vscode.Diagnostic(range, issue.message, vscode.DiagnosticSeverity.Warning);
    diagnostic.source = 'Scala Lite (scalafix)';
    diagnostics.push(diagnostic);
  }

  return diagnostics;
}

export function registerScalafixFeature(logger: StructuredLogger): vscode.Disposable[] {
  const diagnostics = vscode.languages.createDiagnosticCollection('scala-lite-scalafix');
  const fixStateByDocument = new Map<string, ScalafixFixState>();
  const codeLensProvider = new ScalafixCodeLensProvider(fixStateByDocument);

  const codeLensDisposable = vscode.languages.registerCodeLensProvider([{ language: 'scala' }], codeLensProvider);

  const runScalafixDisposable = vscode.commands.registerCommand(COMMAND_RUN_SCALAFIX, async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document.fileName.endsWith('.scala')) {
      vscode.window.showInformationMessage(vscode.l10n.t('Open a Scala file to run Scalafix.'));
      return;
    }

    const document = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) {
      return;
    }

    const config = await readWorkspaceScalafixConfig(folder);
    const budgets = await readBudgetConfigFromWorkspaceConfig();
    const timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : budgets.formatterTimeMs;
    const configUri = vscode.Uri.joinPath(folder.uri, '.scalafix.conf');
    const hasConfig = await fileExists(configUri);

    const workspaceBinUri = vscode.Uri.joinPath(folder.uri, '.scalafix-bin');
    const resolution = resolveScalafixResolution({
      workspaceRoot: folder.uri.fsPath,
      linterPath: config.path,
      hasWorkspaceBinary: await fileExists(workspaceBinUri),
      hasGlobalBinary: await hasGlobalScalafixBinary(folder.uri.fsPath),
      useDocker: Boolean(config.useDocker),
      filePath: document.uri.fsPath,
      workspaceRelativeFilePath: vscode.workspace.asRelativePath(document.uri, false),
      configPath: hasConfig ? configUri.fsPath : undefined
    });

    if (!resolution) {
      vscode.window.showWarningMessage(vscode.l10n.t('No Scalafix binary resolved. Configure linter.path or enable linter.useDocker.'));
      logger.warn('LINT', 'No Scalafix binary resolved; lint run skipped.');
      return;
    }

    const startedAt = Date.now();
    const originalText = document.getText();
    const execution = await runResolvedScalafix(
      resolution.command,
      resolution.args,
      originalText,
      folder.uri.fsPath,
      timeoutMs
    );

    if (execution.status === 'timeout') {
      const seconds = Math.round(timeoutMs / 1000);
      const message = vscode.l10n.t('Scalafix timed out after {0}s. File unchanged.', String(seconds));
      vscode.window.showWarningMessage(message);
      logger.warn('LINT', message, Date.now() - startedAt);
      return;
    }

    if (execution.status === 'error' || typeof execution.stdout !== 'string') {
      logger.error('LINT', `Scalafix failed: ${execution.error ?? 'Unknown error'}`, Date.now() - startedAt);
      return;
    }

    const lines = `${execution.stderr ?? ''}\n${execution.stdout}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const parsedIssues = lines
      .map((line) => parseScalafixOutputLine(line))
      .filter((issue): issue is ScalafixIssue => Boolean(issue));

    const hasTextChanges = execution.stdout !== originalText;
    const issues = parsedIssues.length > 0
      ? parsedIssues
      : hasTextChanges
        ? [{
            filePath: document.uri.fsPath,
            line: 1,
            column: 1,
            message: 'Scalafix suggested automatic changes.',
            fixable: true
          }]
        : [];

    const diagnosticsForDocument = buildDiagnostics(issues, document, folder);
    diagnostics.set(document.uri, diagnosticsForDocument);

    if (hasTextChanges) {
      fixStateByDocument.set(document.uri.toString(), {
        updatedText: execution.stdout,
        issues: issues.map((issue) => ({ ...issue, fixable: issue.fixable || true }))
      });
    } else {
      fixStateByDocument.delete(document.uri.toString());
    }

    logger.info('LINT', `Scalafix run completed with ${diagnosticsForDocument.length} warning diagnostic(s).`, Date.now() - startedAt);
    vscode.commands.executeCommand('editor.action.codelens.refresh');
  });

  const applyFixDisposable = vscode.commands.registerCommand(COMMAND_APPLY_SCALAFIX_FIX, async (args: ApplyScalafixArgs) => {
    const documentUri = vscode.Uri.parse(args.documentUri);
    const state = fixStateByDocument.get(documentUri.toString());
    if (!state) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(documentUri);
    const end = document.lineAt(document.lineCount - 1).range.end;
    const fullRange = new vscode.Range(new vscode.Position(0, 0), end);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(documentUri, fullRange, state.updatedText);
    await vscode.workspace.applyEdit(edit);
    await document.save();
    fixStateByDocument.delete(documentUri.toString());
    diagnostics.delete(documentUri);
    vscode.commands.executeCommand('editor.action.codelens.refresh');
    vscode.window.showInformationMessage(vscode.l10n.t('Applied Scalafix rewrite.'));
  });

  return [
    diagnostics,
    codeLensDisposable,
    runScalafixDisposable,
    applyFixDisposable
  ];
}
