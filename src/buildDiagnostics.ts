import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import {
  parseBuildOutputLine,
  ParsedSeverity
} from './buildOutputParser';
import { StructuredLogger } from './structuredLogger';
import { ScalaLiteLogCategory } from './structuredLogCore';

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
    const cwd = workspaceFolder?.uri.fsPath;
    const category: ScalaLiteLogCategory = terminalName.includes('Test') ? 'TEST' : 'RUN';
    this.logger.info(category, `Executing command: ${command}`);

    const terminal = vscode.window.terminals.find((item) => item.name === terminalName) ?? vscode.window.createTerminal({ name: terminalName });
    terminal.show(true);
    terminal.sendText(`echo ${JSON.stringify(command)}`, true);

    this.outputChannel.appendLine(`$ ${command}`);

    const output = await new Promise<string>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd
      });

      let stdout = '';
      let stderr = '';

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
        resolve(`${stdout}\n${stderr}`);
      });

      child.on('close', () => {
        resolve(`${stdout}\n${stderr}`);
      });
    });

    const grouped = diagnosticsForOutput(output, workspaceFolder);
    let diagnosticsCount = 0;
    for (const entry of grouped.values()) {
      this.diagnostics.set(entry.uri, entry.diagnostics);
      diagnosticsCount += entry.diagnostics.length;
    }

    this.logger.info('DIAG', `Parsed ${diagnosticsCount} diagnostics from build output.`, Date.now() - startedAt);
  }
}