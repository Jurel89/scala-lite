import * as vscode from 'vscode';
import { Minimatch } from 'minimatch';
import { StructuredLogger } from './structuredLogger';
import { WorkspaceMode } from './modePresentation';
import { readModuleFolderFromWorkspaceConfig } from './workspaceConfig';
import { resolveWorkspaceIgnoreRules } from './ignoreRules';
import { NativeDiagnostic, NativeParseResult, NativeEngine } from './nativeEngine';
import { compareSymbols } from './symbolSort';

export const COMMAND_REBUILD_INDEX = 'scalaLite.rebuildIndex';

type SymbolKind = 'package' | 'object' | 'class' | 'trait' | 'def' | 'val' | 'type' | 'param';
type SymbolVisibility = 'public' | 'protected' | 'private' | 'unknown';

function isValidIndexedSymbol(symbol: IndexedSymbol | undefined): symbol is IndexedSymbol {
  if (!symbol) {
    return false;
  }

  return typeof symbol.symbolName === 'string'
    && symbol.symbolName.length > 0
    && typeof symbol.filePath === 'string'
    && symbol.filePath.length > 0
    && typeof symbol.lineNumber === 'number'
    && Number.isFinite(symbol.lineNumber)
    && typeof symbol.packageName === 'string'
    && typeof symbol.visibility === 'string';
}

export interface IndexedSymbol {
  readonly symbolName: string;
  readonly symbolKind: SymbolKind;
  readonly filePath: string;
  readonly lineNumber: number;
  readonly packageName: string;
  readonly visibility: SymbolVisibility;
  readonly containerName?: string;
}

export interface ImportRecord {
  readonly packagePath: string;
  readonly importedName?: string;
  readonly sourceSymbolName?: string;
  readonly isWildcard: boolean;
  readonly lineNumber: number;
}

function isIndexableFile(document: vscode.TextDocument): boolean {
  return document.fileName.endsWith('.scala') || document.fileName.endsWith('.sbt');
}

function extractSymbols(document: vscode.TextDocument): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  let currentContainerName: string | undefined;
  let currentPackageName = '';

  const packageRegex = /^\s*package\s+([A-Za-z0-9_.]+)/;
  const objectRegex = /^\s*object\s+([A-Za-z0-9_]+)/;
  const classRegex = /^\s*(?:final\s+|sealed\s+|abstract\s+)*class\s+([A-Za-z0-9_]+)/;
  const traitRegex = /^\s*(?:sealed\s+)?trait\s+([A-Za-z0-9_]+)/;
  const defRegex = /^\s*(?:override\s+|private\s+|protected\s+)*def\s+([A-Za-z0-9_]+)/;
  const valRegex = /^\s*(?:private\s+|protected\s+)*val\s+([A-Za-z0-9_]+)/;
  const typeRegex = /^\s*type\s+([A-Za-z0-9_]+)/;

  const inferVisibility = (lineText: string): SymbolVisibility => {
    const normalized = lineText.trimStart();
    if (normalized.startsWith('private')) {
      return 'private';
    }
    if (normalized.startsWith('protected')) {
      return 'protected';
    }
    if (/^(package|object|class|trait|def|val|var|type|enum|given)\b/.test(normalized)) {
      return 'public';
    }

    return 'unknown';
  };

  for (let index = 0; index < document.lineCount; index += 1) {
    const line = document.lineAt(index).text;

    const packageMatch = line.match(packageRegex);
    if (packageMatch) {
      if (!currentPackageName) {
        currentPackageName = packageMatch[1];
      }
      symbols.push({
        symbolName: packageMatch[1],
        symbolKind: 'package',
        filePath: document.uri.fsPath,
        lineNumber: index + 1,
        packageName: currentPackageName,
        visibility: inferVisibility(line)
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
        packageName: currentPackageName,
        visibility: inferVisibility(line),
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
        packageName: currentPackageName,
        visibility: inferVisibility(line),
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
        packageName: currentPackageName,
        visibility: inferVisibility(line),
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
        packageName: currentPackageName,
        visibility: inferVisibility(line),
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
        packageName: currentPackageName,
        visibility: inferVisibility(line),
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
        packageName: currentPackageName,
        visibility: inferVisibility(line),
        containerName: currentContainerName
      });
    }
  }

  return symbols;
}

export class SymbolIndexManager implements vscode.Disposable {
  private readonly logger: StructuredLogger;
  private readonly getNativeEngine: () => NativeEngine;
  private readonly indexByFile = new Map<string, IndexedSymbol[]>();
  private readonly diagnosticsByFile = new Map<string, NativeDiagnostic[]>();
  private readonly importsByFile = new Map<string, ImportRecord[]>();
  private readonly packageByFile = new Map<string, string>();
  private readonly contentByFile = new Map<string, string>();
  private readonly fileCloseEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private currentMode: WorkspaceMode = 'A';
  private readonly disposables: vscode.Disposable[] = [];
  private modeRebuildCancellation = new vscode.CancellationTokenSource();

  public constructor(logger: StructuredLogger, getNativeEngine: () => NativeEngine) {
    this.logger = logger;
    this.getNativeEngine = getNativeEngine;
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

      await this.indexDocument(document);
      await this.syncNativeIndex();
      this.logger.info('INDEX', `Incremental index update: ${document.uri.fsPath}`);
    });

    const openDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
      if (!isIndexableFile(document) || this.currentMode !== 'B') {
        return;
      }

      await this.indexDocument(document);
      await this.syncNativeIndex();
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
        this.contentByFile.delete(document.uri.fsPath);
        this.diagnosticsByFile.delete(document.uri.fsPath);
        this.importsByFile.delete(key);
        this.packageByFile.delete(document.uri.fsPath);
        this.fileCloseEvictionTimers.delete(key);
        void this.evictFileFromNativeIndex(document.uri.fsPath);
      }, 1000);

      this.fileCloseEvictionTimers.set(key, evictionTimer);
    });

    this.disposables.push(rebuildDisposable, saveDisposable, openDisposable, closeDisposable);
    context.subscriptions.push(...this.disposables);
  }

  public dispose(): void {
    this.modeRebuildCancellation.cancel();
    this.modeRebuildCancellation.dispose();
    for (const timer of this.fileCloseEvictionTimers.values()) {
      clearTimeout(timer);
    }
    this.fileCloseEvictionTimers.clear();
    this.indexByFile.clear();
    this.contentByFile.clear();
    this.diagnosticsByFile.clear();
    this.importsByFile.clear();
    this.packageByFile.clear();
  }

  public async setMode(mode: WorkspaceMode): Promise<void> {
    this.modeRebuildCancellation.cancel();
    this.modeRebuildCancellation.dispose();
    this.modeRebuildCancellation = new vscode.CancellationTokenSource();
    this.currentMode = mode;
    await this.rebuild(this.modeRebuildCancellation.token);
  }

  public getAllSymbols(): readonly IndexedSymbol[] {
    const result: IndexedSymbol[] = [];
    for (const symbols of this.indexByFile.values()) {
      result.push(...symbols.filter((symbol) => isValidIndexedSymbol(symbol)));
    }
    return result;
  }

  public getSymbolsForFile(documentUri: vscode.Uri): readonly IndexedSymbol[] {
    return this.indexByFile.get(documentUri.toString()) ?? [];
  }

  public getImportsForFile(documentUri: vscode.Uri): readonly ImportRecord[] {
    return this.importsByFile.get(documentUri.toString()) ?? [];
  }

  public getSymbolsForPackage(packagePath: string): readonly IndexedSymbol[] {
    if (!packagePath) {
      return [];
    }

    const matches: IndexedSymbol[] = [];
    for (const symbols of this.indexByFile.values()) {
      for (const symbol of symbols) {
        if (symbol.symbolKind === 'package') {
          continue;
        }

        const symbolPackage = symbol.packageName || this.packageByFile.get(symbol.filePath);
        if (symbolPackage === packagePath) {
          matches.push(symbol);
        }
      }
    }

    return matches.sort((left, right) => compareSymbols(left, right));
  }

  public async querySymbolsInPackage(
    query: string,
    packagePath: string,
    limit: number,
    token?: vscode.CancellationToken
  ): Promise<readonly IndexedSymbol[]> {
    if (this.currentMode === 'A' || !query.trim() || !packagePath.trim()) {
      return [];
    }

    if (token?.isCancellationRequested) {
      return [];
    }

    try {
      const nativeMatches = await this.getNativeEngine().querySymbolsInPackage(query.trim(), packagePath.trim(), limit, token);
      if (nativeMatches.length > 0) {
        return nativeMatches.filter((symbol) => isValidIndexedSymbol(symbol));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native query_symbols_in_package failed. Falling back to in-memory scan. ${message}`);
    }

    return this.getSymbolsForPackage(packagePath)
      .filter((symbol) => symbol.symbolName === query.trim())
      .slice(0, Math.max(1, limit));
  }

  public async packageExists(packagePath: string, token?: vscode.CancellationToken): Promise<boolean> {
    if (!packagePath.trim()) {
      return false;
    }

    if (token?.isCancellationRequested) {
      return false;
    }

    try {
      return await this.getNativeEngine().queryPackageExists(packagePath.trim(), token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native query_package_exists failed. Falling back to in-memory package map. ${message}`);
      return Array.from(this.packageByFile.values()).some((entry) => entry === packagePath.trim());
    }
  }

  public async searchSymbols(
    query: string,
    limit: number,
    token?: vscode.CancellationToken
  ): Promise<readonly IndexedSymbol[]> {
    if (this.currentMode === 'A') {
      return [];
    }

    if (token?.isCancellationRequested) {
      return [];
    }

    const normalized = query.trim();
    if (!normalized) {
      return this.getAllSymbols().slice(0, Math.max(1, limit));
    }

    try {
      const nativeMatches = (await this.getNativeEngine().querySymbols(normalized, limit, token))
        .filter((symbol) => isValidIndexedSymbol(symbol));
      if (nativeMatches.length > 0) {
        return nativeMatches;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native query_symbols failed. Using TypeScript index fallback. ${message}`);
    }

    return this.searchSymbolsFallback(normalized, limit);
  }

  public async getDiagnosticsForDocument(
    document: vscode.TextDocument,
    token?: vscode.CancellationToken
  ): Promise<readonly NativeDiagnostic[]> {
    if (this.currentMode === 'A' || !isIndexableFile(document)) {
      return [];
    }

    const filePath = document.uri.fsPath;
    const cached = this.diagnosticsByFile.get(filePath);
    if (cached) {
      return cached;
    }

    const parsed = await this.tryParseWithNative(filePath, document.getText(), token);
    if (!parsed) {
      return [];
    }

    this.diagnosticsByFile.set(filePath, [...parsed.diagnostics]);
    return parsed.diagnostics;
  }

  private async rebuild(token?: vscode.CancellationToken): Promise<void> {
    this.indexByFile.clear();
    this.contentByFile.clear();
    this.diagnosticsByFile.clear();
    this.importsByFile.clear();
    this.packageByFile.clear();

    if (token?.isCancellationRequested) {
      return;
    }

    if (this.currentMode === 'A') {
      this.logger.info('INDEX', 'Mode A active: index cleared (no indexing).');
      return;
    }

    if (this.currentMode === 'B') {
      const openTextDocuments = vscode.workspace.textDocuments.filter((document) => isIndexableFile(document));
      this.logger.debug('INDEX', `Mode B rebuild started with ${openTextDocuments.length} open indexable file(s).`);
      for (const document of openTextDocuments) {
        if (token?.isCancellationRequested) {
          this.logger.info('INDEX', 'Mode B index rebuild cancelled.');
          return;
        }
        await this.indexDocument(document, token);
      }
      await this.syncNativeIndex(token);
      this.logger.info('INDEX', `Mode B index rebuilt from ${openTextDocuments.length} open file(s).`);
      return;
    }

    await this.rebuildModeC(token);
  }

  private async rebuildModeC(token?: vscode.CancellationToken): Promise<void> {
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
      if (token?.isCancellationRequested) {
        this.logger.info('INDEX', 'Mode C index rebuild cancelled.');
        return;
      }

      try {
        const document = await vscode.workspace.openTextDocument(fileUri);
        await this.indexDocument(document, token);
      } catch {
      }
    }

    await this.syncNativeIndex(token);

    this.logger.debug('INDEX', `Mode C rebuild completed with ${this.contentByFile.size} file(s) loaded in memory.`);

    this.logger.info('INDEX', `Mode C index rebuilt from ${filteredFiles.length} file(s).`);
  }

  private async indexDocument(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void> {
    const content = document.getText();
    const parsed = await this.tryParseWithNative(document.uri.fsPath, content, token);
    const symbols = (parsed?.symbols ?? extractSymbols(document)).filter((symbol) => isValidIndexedSymbol(symbol));
    const imports = parsed?.imports ?? [];
    this.logger.debug(
      'INDEX',
      `Indexed ${document.uri.fsPath} with ${symbols.length} symbol(s) using ${parsed ? 'native' : 'typescript'} parser.`
    );
    this.indexByFile.set(document.uri.toString(), [...symbols]);
    this.importsByFile.set(document.uri.toString(), [...imports]);
    const packageSymbol = symbols.find((symbol) => symbol.symbolKind === 'package');
    if (packageSymbol) {
      this.packageByFile.set(document.uri.fsPath, packageSymbol.packageName || packageSymbol.symbolName);
    } else {
      this.packageByFile.delete(document.uri.fsPath);
    }
    this.contentByFile.set(document.uri.fsPath, content);
    this.diagnosticsByFile.set(document.uri.fsPath, [...(parsed?.diagnostics ?? [])]);
  }

  private async tryParseWithNative(
    filePath: string,
    content: string,
    token?: vscode.CancellationToken
  ): Promise<NativeParseResult | undefined> {
    if (token?.isCancellationRequested) {
      return undefined;
    }

    try {
      return await this.getNativeEngine().parseFile(filePath, content, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native parse_file failed for ${filePath}. Using TypeScript parser fallback. ${message}`);
      return undefined;
    }
  }

  private async syncNativeIndex(token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) {
      return;
    }

    const files = Array.from(this.contentByFile.entries()).map(([filePath, content]) => ({
      filePath,
      content
    }));

    try {
      const total = await this.getNativeEngine().rebuildIndex(files, token);
      this.logger.debug('INDEX', `Native index sync completed for ${files.length} file(s), ${total} symbol(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native rebuild_index failed. Continuing with TypeScript index fallback. ${message}`);
    }
  }

  private async evictFileFromNativeIndex(filePath: string): Promise<void> {
    try {
      await this.getNativeEngine().evictFile(filePath);
    } catch {
    }
  }

  private searchSymbolsFallback(query: string, limit: number): readonly IndexedSymbol[] {
    const normalizedQuery = query.toLowerCase();
    const ranked: Array<{ score: number; symbol: IndexedSymbol }> = [];

    for (const symbol of this.getAllSymbols()) {
      if (!isValidIndexedSymbol(symbol)) {
        continue;
      }

      const score = this.fuzzyScore(normalizedQuery, symbol.symbolName.toLowerCase());
      if (score === undefined) {
        continue;
      }

      ranked.push({ score, symbol });
    }

    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return compareSymbols(left.symbol, right.symbol);
    });
    return ranked.slice(0, Math.max(1, limit)).map((entry) => entry.symbol);
  }

  private fuzzyScore(query: string, candidate: string): number | undefined {
    if (!query) {
      return 0;
    }

    let cursor = 0;
    let score = 0;

    for (let index = 0; index < query.length; index += 1) {
      const foundAt = candidate.indexOf(query[index], cursor);
      if (foundAt === -1) {
        return undefined;
      }

      score += 20;
      if (foundAt === index) {
        score += 40;
      }

      if (foundAt === cursor) {
        score += 10;
      }

      cursor = foundAt + 1;
    }

    return score - Math.max(0, candidate.length - query.length);
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
