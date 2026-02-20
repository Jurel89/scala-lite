import * as vscode from 'vscode';
import { Minimatch } from 'minimatch';
import { StructuredLogger } from './structuredLogger';
import { WorkspaceMode } from './modePresentation';
import { readModuleFolderFromWorkspaceConfig } from './workspaceConfig';
import { resolveWorkspaceIgnoreRules } from './ignoreRules';

export const COMMAND_REBUILD_INDEX = 'scalaLite.rebuildIndex';

type SymbolKind = 'package' | 'object' | 'class' | 'trait' | 'def' | 'val' | 'type';

export interface IndexedSymbol {
  readonly symbolName: string;
  readonly symbolKind: SymbolKind;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly containerName?: string;
}

function isIndexableFile(document: vscode.TextDocument): boolean {
  return document.fileName.endsWith('.scala') || document.fileName.endsWith('.sbt');
}

function extractSymbols(document: vscode.TextDocument): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  let currentContainerName: string | undefined;

  const packageRegex = /^\s*package\s+([A-Za-z0-9_.]+)/;
  const objectRegex = /^\s*object\s+([A-Za-z0-9_]+)/;
  const classRegex = /^\s*(?:final\s+|sealed\s+|abstract\s+)*class\s+([A-Za-z0-9_]+)/;
  const traitRegex = /^\s*(?:sealed\s+)?trait\s+([A-Za-z0-9_]+)/;
  const defRegex = /^\s*(?:override\s+|private\s+|protected\s+)*def\s+([A-Za-z0-9_]+)/;
  const valRegex = /^\s*(?:private\s+|protected\s+)*val\s+([A-Za-z0-9_]+)/;
  const typeRegex = /^\s*type\s+([A-Za-z0-9_]+)/;

  for (let index = 0; index < document.lineCount; index += 1) {
    const line = document.lineAt(index).text;

    const packageMatch = line.match(packageRegex);
    if (packageMatch) {
      symbols.push({
        symbolName: packageMatch[1],
        symbolKind: 'package',
        filePath: document.uri.fsPath,
        lineNumber: index + 1
      });
      currentContainerName = packageMatch[1];
      continue;
    }

    const objectMatch = line.match(objectRegex);
    if (objectMatch) {
      symbols.push({
        symbolName: objectMatch[1],
        symbolKind: 'object',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        containerName: currentContainerName
      });
      currentContainerName = objectMatch[1];
      continue;
    }

    const classMatch = line.match(classRegex);
    if (classMatch) {
      symbols.push({
        symbolName: classMatch[1],
        symbolKind: 'class',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        containerName: currentContainerName
      });
      continue;
    }

    const traitMatch = line.match(traitRegex);
    if (traitMatch) {
      symbols.push({
        symbolName: traitMatch[1],
        symbolKind: 'trait',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        containerName: currentContainerName
      });
      continue;
    }

    const defMatch = line.match(defRegex);
    if (defMatch) {
      symbols.push({
        symbolName: defMatch[1],
        symbolKind: 'def',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        containerName: currentContainerName
      });
      continue;
    }

    const valMatch = line.match(valRegex);
    if (valMatch) {
      symbols.push({
        symbolName: valMatch[1],
        symbolKind: 'val',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        containerName: currentContainerName
      });
      continue;
    }

    const typeMatch = line.match(typeRegex);
    if (typeMatch) {
      symbols.push({
        symbolName: typeMatch[1],
        symbolKind: 'type',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        containerName: currentContainerName
      });
    }
  }

  return symbols;
}

export class SymbolIndexManager implements vscode.Disposable {
  private readonly logger: StructuredLogger;
  private readonly indexByFile = new Map<string, IndexedSymbol[]>();
  private readonly fileCloseEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private currentMode: WorkspaceMode = 'A';
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(logger: StructuredLogger) {
    this.logger = logger;
  }

  public initialize(context: vscode.ExtensionContext): void {
    const rebuildDisposable = vscode.commands.registerCommand(COMMAND_REBUILD_INDEX, async () => {
      await this.rebuild();
      vscode.window.showInformationMessage(vscode.l10n.t('Scala Lite index rebuilt.'));
    });

    const saveDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (!isIndexableFile(document) || this.currentMode === 'A') {
        return;
      }

      if (!(await this.isDocumentInScope(document))) {
        return;
      }

      this.indexDocument(document);
      this.logger.info('INDEX', `Incremental index update: ${document.uri.fsPath}`);
    });

    const openDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
      if (!isIndexableFile(document) || this.currentMode !== 'B') {
        return;
      }

      this.indexDocument(document);
    });

    const closeDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
      if (this.currentMode !== 'B') {
        return;
      }

      const key = document.uri.toString();
      const existingTimer = this.fileCloseEvictionTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const evictionTimer = setTimeout(() => {
        this.indexByFile.delete(key);
        this.fileCloseEvictionTimers.delete(key);
      }, 1000);

      this.fileCloseEvictionTimers.set(key, evictionTimer);
    });

    this.disposables.push(rebuildDisposable, saveDisposable, openDisposable, closeDisposable);
    context.subscriptions.push(...this.disposables);
  }

  public dispose(): void {
    for (const timer of this.fileCloseEvictionTimers.values()) {
      clearTimeout(timer);
    }
    this.fileCloseEvictionTimers.clear();
    this.indexByFile.clear();
  }

  public async setMode(mode: WorkspaceMode): Promise<void> {
    this.currentMode = mode;
    await this.rebuild();
  }

  public getAllSymbols(): readonly IndexedSymbol[] {
    const result: IndexedSymbol[] = [];
    for (const symbols of this.indexByFile.values()) {
      result.push(...symbols);
    }
    return result;
  }

  public getSymbolsForFile(documentUri: vscode.Uri): readonly IndexedSymbol[] {
    return this.indexByFile.get(documentUri.toString()) ?? [];
  }

  private async rebuild(): Promise<void> {
    this.indexByFile.clear();

    if (this.currentMode === 'A') {
      this.logger.info('INDEX', 'Mode A active: index cleared (no indexing).');
      return;
    }

    if (this.currentMode === 'B') {
      const openTextDocuments = vscode.workspace.textDocuments.filter((document) => isIndexableFile(document));
      for (const document of openTextDocuments) {
        this.indexDocument(document);
      }
      this.logger.info('INDEX', `Mode B index rebuilt from ${openTextDocuments.length} open file(s).`);
      return;
    }

    await this.rebuildModeC();
  }

  private async rebuildModeC(): Promise<void> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const moduleRelativePath = await readModuleFolderFromWorkspaceConfig();
    const moduleUri = moduleRelativePath
      ? vscode.Uri.joinPath(workspaceFolder.uri, moduleRelativePath)
      : workspaceFolder.uri;

    const ignoreRules = await resolveWorkspaceIgnoreRules();
    const ignoreMatchers = ignoreRules.effectivePatterns.map((pattern) => new Minimatch(pattern, { dot: true }));

    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(moduleUri, '**/*.{scala,sbt}'),
      undefined,
      5000
    );

    const filteredFiles = files.filter((fileUri) => {
      const relativePath = vscode.workspace.asRelativePath(fileUri, false).replace(/^[^/]+\//, '');
      return !ignoreMatchers.some((matcher) => matcher.match(relativePath) || matcher.match(`${relativePath}/`));
    });

    for (const fileUri of filteredFiles) {
      try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        this.indexDocument(document);
      } catch {
      }
    }

    this.logger.info('INDEX', `Mode C index rebuilt from ${filteredFiles.length} file(s).`);
  }

  private indexDocument(document: vscode.TextDocument): void {
    const symbols = extractSymbols(document);
    this.indexByFile.set(document.uri.toString(), symbols);
  }

  private async isDocumentInScope(document: vscode.TextDocument): Promise<boolean> {
    if (this.currentMode === 'B') {
      return true;
    }

    if (this.currentMode === 'C') {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return false;
      }

      const moduleRelativePath = await readModuleFolderFromWorkspaceConfig();
      if (!moduleRelativePath) {
        return true;
      }

      const modulePrefix = moduleRelativePath.endsWith('/') ? moduleRelativePath : `${moduleRelativePath}/`;
      const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/^[^/]+\//, '');
      return relativePath.startsWith(modulePrefix);
    }

    return false;
  }
}
