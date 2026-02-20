import * as vscode from 'vscode';
import { WorkspaceMode } from './modePresentation';
import { SymbolIndexManager } from './symbolIndex';
import { NativeDiagnostic } from './nativeEngine';
import { StructuredLogger } from './structuredLogger';
import { readDiagnosticsConfigFromWorkspaceConfig } from './workspaceConfig';

function isSyntaxDiagnosticsFile(document: vscode.TextDocument): boolean {
  return document.fileName.endsWith('.scala') || document.fileName.endsWith('.sbt');
}

function toDiagnosticSeverity(severity: NativeDiagnostic['severity']): vscode.DiagnosticSeverity {
  return severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
}

function toVscodeDiagnostics(entries: readonly NativeDiagnostic[]): vscode.Diagnostic[] {
  return entries.map((entry) => {
    const line = Math.max(0, entry.lineNumber - 1);
    const column = Math.max(0, entry.column - 1);
    const range = new vscode.Range(new vscode.Position(line, column), new vscode.Position(line, column + 1));
    const diagnostic = new vscode.Diagnostic(range, entry.message, toDiagnosticSeverity(entry.severity));
    diagnostic.source = 'Scala Lite (syntax)';
    return diagnostic;
  });
}

export class SyntaxDiagnosticsController implements vscode.Disposable {
  private static readonly ON_TYPE_DEBOUNCE_MS = 500;

  private readonly symbolIndexManager: SymbolIndexManager;
  private readonly getMode: () => WorkspaceMode;
  private readonly logger: StructuredLogger;
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[];
  private readonly pendingRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  public constructor(
    symbolIndexManager: SymbolIndexManager,
    getMode: () => WorkspaceMode,
    logger: StructuredLogger
  ) {
    this.symbolIndexManager = symbolIndexManager;
    this.getMode = getMode;
    this.logger = logger;
    this.diagnostics = vscode.languages.createDiagnosticCollection('scala-lite-syntax');

    const openDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
      await this.refreshDocument(document);
    });

    const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
      const config = await readDiagnosticsConfigFromWorkspaceConfig();
      if (config.enabled && config.trigger === 'onSave') {
        await this.refreshDocument(document);
      }
    });

    const changeDisposable = vscode.workspace.onDidChangeTextDocument(async (event) => {
      const document = event.document;
      if (!isSyntaxDiagnosticsFile(document)) {
        return;
      }

      const config = await readDiagnosticsConfigFromWorkspaceConfig();
      if (!config.enabled || config.trigger !== 'onType') {
        return;
      }

      const key = document.uri.toString();
      const existingTimer = this.pendingRefreshTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        this.pendingRefreshTimers.delete(key);
        void this.refreshDocument(document);
      }, SyntaxDiagnosticsController.ON_TYPE_DEBOUNCE_MS);

      this.pendingRefreshTimers.set(key, timer);
    });

    const closeDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
      this.diagnostics.delete(document.uri);
    });

    this.disposables = [openDisposable, saveDisposable, changeDisposable, closeDisposable, this.diagnostics];
  }

  public async refreshOpenDocuments(token?: vscode.CancellationToken): Promise<void> {
    const config = await readDiagnosticsConfigFromWorkspaceConfig();
    if (!config.enabled) {
      this.diagnostics.clear();
      return;
    }

    const documents = vscode.workspace.textDocuments.filter((document) => isSyntaxDiagnosticsFile(document));
    for (const document of documents) {
      if (token?.isCancellationRequested) {
        return;
      }

      await this.refreshDocument(document, token);
    }
  }

  public dispose(): void {
    for (const timer of this.pendingRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingRefreshTimers.clear();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private async refreshDocument(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void> {
    if (!isSyntaxDiagnosticsFile(document)) {
      return;
    }

    const config = await readDiagnosticsConfigFromWorkspaceConfig();
    if (!config.enabled) {
      this.diagnostics.delete(document.uri);
      return;
    }

    try {
      const entries = await this.symbolIndexManager.getDiagnosticsForDocument(document, token);
      this.diagnostics.set(document.uri, toVscodeDiagnostics(entries));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('DIAG', `Syntax diagnostics refresh failed for ${document.uri.fsPath}. ${message}`);
    }
  }
}
