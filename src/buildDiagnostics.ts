import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import {
  parseBuildOutputLine,
  ParsedSeverity
} from './buildOutputParser';
import { StructuredLogger } from './structuredLogger';
import { ScalaLiteLogCategory } from './structuredLogCore';
import { BudgetRunner, runWithBudgetExtension } from './budgetCore';
import { readBudgetConfigFromWorkspaceConfig } from './workspaceConfig';

export interface ParsedBuildDiagnostic {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly severity: vscode.DiagnosticSeverity;
}

function toDiagnosticSeverity(severity: ParsedSeverity): vscode.DiagnosticSeverity {
  return severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
}

function resolveDiagnosticUri(baseFolder: vscode.WorkspaceFolder | undefined, filePath: string): vscode.Uri {
  if (filePath.startsWith('/')) {
    return vscode.Uri.file(filePath);
  }

  if (!baseFolder) {
    return vscode.Uri.file(filePath);
  }

  return vscode.Uri.joinPath(baseFolder.uri, filePath);
}

function diagnosticsForOutput(
  output: string,
  baseFolder: vscode.WorkspaceFolder | undefined
): Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }> {
  const byFile = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();

  for (const line of output.split(/\r?\n/)) {
    const parsed = parseBuildOutputLine(line);
    if (!parsed) {
      continue;
    }

    const uri = resolveDiagnosticUri(baseFolder, parsed.filePath);
    const key = uri.toString();

    const range = new vscode.Range(
      Math.max(0, parsed.line - 1),
      Math.max(0, parsed.column - 1),
      Math.max(0, parsed.line - 1),
      Math.max(0, parsed.column)
    );

    const diagnostic = new vscode.Diagnostic(range, parsed.message, toDiagnosticSeverity(parsed.severity));
    diagnostic.source = 'Scala Lite (build)';

    const existing = byFile.get(key);
    if (existing) {
      existing.diagnostics.push(diagnostic);
      continue;
    }

    byFile.set(key, {
      uri,
      diagnostics: [diagnostic]
    });
  }

  return byFile;
}

export class BuildDiagnosticsRunner implements vscode.Disposable {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly outputChannel: vscode.OutputChannel;
  private readonly logger: StructuredLogger;

  public constructor(logger: StructuredLogger) {
    this.diagnostics = vscode.languages.createDiagnosticCollection('scala-lite-build');
    this.outputChannel = vscode.window.createOutputChannel('Scala Lite Build');
    this.logger = logger;
  }

  public dispose(): void {
    this.diagnostics.dispose();
    this.outputChannel.dispose();
  }

  public async runCommand(command: string, documentUri: vscode.Uri, terminalName: string): Promise<void> {
    const startedAt = Date.now();
    this.diagnostics.clear();

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
    if (!workspaceFolder) {
      this.logger.warn('CONFIG', 'Command execution skipped: no workspace folder available for sandboxed cwd.');
      return;
    }

    const cwd = workspaceFolder.uri.fsPath;
    const category: ScalaLiteLogCategory = terminalName.includes('Test') ? 'TEST' : 'RUN';
    this.logger.info(category, `Executing command: ${this.sanitizeCommandForLog(command)}`);

    const terminal = vscode.window.terminals.find((item) => item.name === terminalName) ?? vscode.window.createTerminal({ name: terminalName });
    terminal.show(true);
    terminal.sendText(`echo ${JSON.stringify(command)}`, true);

    this.outputChannel.appendLine(`$ ${command}`);

    const budgets = await readBudgetConfigFromWorkspaceConfig();

    const executeWithBudget = async (timeBudgetMs: number) => {
      const runner = new BudgetRunner<{ output: string; timedOut: boolean }>({
        operationName: terminalName,
        timeBudgetMs: timeBudgetMs + 1000
      });

      const result = await runner.run(() => this.runCommandWithStreamingOutput(command, cwd, timeBudgetMs));
      if (result.status === 'completed' && result.value?.timedOut) {
        return {
          status: 'stopped' as const,
          elapsedMs: result.elapsedMs,
          stopReason: 'time' as const,
          cpuDeltaMicros: result.cpuDeltaMicros,
          value: result.value.output
        };
      }

      return {
        ...result,
        value: result.value?.output
      };
    };

    const budgetEnvelope = await runWithBudgetExtension({
      operationName: terminalName,
      initialTimeBudgetMs: budgets.indexTimeMs,
      executeWithBudget,
      requestAction: async ({ operationName, elapsedMs, nextBudgetMs }) => {
        const action = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            '⏱ {0} stopped at budget limit ({1}ms). [Show Partial] [Extend to {2}ms] [Cancel]',
            operationName,
            String(elapsedMs),
            String(nextBudgetMs)
          ),
          vscode.l10n.t('Show Partial'),
          vscode.l10n.t('Extend to {0}ms', String(nextBudgetMs)),
          vscode.l10n.t('Cancel')
        );

        if (action === vscode.l10n.t('Extend to {0}ms', String(nextBudgetMs))) {
          return 'extend';
        }

        if (action === vscode.l10n.t('Cancel')) {
          return 'cancel';
        }

        return 'show-partial';
      }
    });
    const output = budgetEnvelope.result.value ?? '';
    if (budgetEnvelope.result.status === 'stopped') {
      this.logger.warn(
        'BUDGET',
        `[BUDGET] ${terminalName} stopped at ${budgetEnvelope.result.elapsedMs}ms (budget ${budgetEnvelope.finalBudgetMs}ms).` +
          ` CPU delta ${budgetEnvelope.result.cpuDeltaMicros}μs.`
      );
    }

    const grouped = diagnosticsForOutput(output, workspaceFolder);
    let diagnosticsCount = 0;
    for (const entry of grouped.values()) {
      this.diagnostics.set(entry.uri, entry.diagnostics);
      diagnosticsCount += entry.diagnostics.length;
    }

    this.logger.info('DIAG', `Parsed ${diagnosticsCount} diagnostics from build output.`, Date.now() - startedAt);
  }

  private sanitizeCommandForLog(command: string): string {
    return command.replace(/\b([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=<redacted>');
  }

  private runCommandWithStreamingOutput(
    command: string,
    cwd: string | undefined,
    timeBudgetMs: number
  ): Promise<{ output: string; timedOut: boolean }> {
    return new Promise<{ output: string; timedOut: boolean }>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const finish = (timedOut: boolean): void => {
        if (resolved) {
          return;
        }

        resolved = true;
        resolve({
          output: `${stdout}\n${stderr}`,
          timedOut
        });
      };

      const timeoutHandle = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
        }
        finish(true);
      }, Math.max(1, timeBudgetMs));

      child.stdout.on('data', (chunk) => {
        const text = String(chunk);
        stdout += text;
        this.outputChannel.append(text);
      });

      child.stderr.on('data', (chunk) => {
        const text = String(chunk);
        stderr += text;
        this.outputChannel.append(text);
      });

      child.on('error', (error) => {
        this.outputChannel.appendLine(`\n[Scala Lite] Failed to run command: ${error.message}`);
        clearTimeout(timeoutHandle);
        finish(false);
      });

      child.on('close', () => {
        clearTimeout(timeoutHandle);
        finish(false);
      });
    });
  }
}