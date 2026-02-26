import * as vscode from 'vscode';
import { Minimatch } from 'minimatch';
import { StructuredLogger } from './structuredLogger';
import { WorkspaceMode } from './modePresentation';
import { readIndexBatchSizeFromWorkspaceConfig, readModuleFolderFromWorkspaceConfig } from './workspaceConfig';
import { resolveWorkspaceIgnoreRules } from './ignoreRules';
import { NativeDiagnostic, NativeMemoryUsage, NativeParseResult, NativeEngine } from './nativeEngine';
import { compareSymbols } from './symbolSort';
import type { WorkspaceMemoryMetrics } from './memoryBudget';
import { JsStringTable } from './jsStringTable';

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

export interface MemoryBreakdown {
  readonly fileCount: number;
  readonly symbolCount: number;
  readonly importCount: number;
  readonly diagnosticCount: number;
  readonly contentCacheBytes: number;
  readonly estimatedJsHeapBytes: number;
  readonly nativeMemoryUsage: NativeMemoryUsage;
  readonly stringTableEntries?: number;
  readonly stringTableBytes?: number;
}

function isIndexableFile(document: vscode.TextDocument): boolean {
  return document.fileName.endsWith('.scala') || document.fileName.endsWith('.sbt');
}

function extractSymbolsFromContent(filePath: string, content: string): IndexedSymbol[] {
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

  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const packageMatch = line.match(packageRegex);
    if (packageMatch) {
      if (!currentPackageName) {
        currentPackageName = packageMatch[1];
      }
      symbols.push({
        symbolName: packageMatch[1],
        symbolKind: 'package',
        filePath,
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
        filePath,
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
        filePath,
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
        filePath,
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
        filePath,
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
        filePath,
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
        filePath,
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
  private static readonly FILE_CLOSE_EVICTION_DELAY_MS = 1000;
  private static readonly DEFAULT_NATIVE_SYNC_BATCH_SIZE = 100;
  private readonly modeCRebuildCompletedEmitter = new vscode.EventEmitter<void>();
  private readonly stringTable = new JsStringTable();
  private readonly logger: StructuredLogger;
  private readonly getNativeEngine: () => NativeEngine;
  private readonly indexByFile = new Map<string, IndexedSymbol[]>();
  private readonly diagnosticsByFile = new Map<string, NativeDiagnostic[]>();
  private readonly importsByFile = new Map<string, ImportRecord[]>();
  private readonly packageByFile = new Map<string, string>();
  private readonly fileCloseEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private currentMode: WorkspaceMode = 'A';
  private readonly disposables: vscode.Disposable[] = [];
  private modeRebuildCancellation = new vscode.CancellationTokenSource();

  public constructor(logger: StructuredLogger, getNativeEngine: () => NativeEngine) {
    this.logger = logger;
    this.getNativeEngine = getNativeEngine;
  }

  /** Canonical key for all per-file Maps. Uses fsPath for consistency with the native engine. */
  private fileKey(uri: vscode.Uri): string {
    return uri.fsPath;
  }

  public readonly onDidModeCRebuildCompleted: vscode.Event<void> = this.modeCRebuildCompletedEmitter.event;

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

      const content = document.getText();
      await this.indexFileContent(document.uri, content);
      await this.appendNativeIndexBatch([{ filePath: document.uri.fsPath, content }]);
      this.logger.info('INDEX', `Incremental index update: ${document.uri.fsPath}`);
    });

    const openDisposable = vscode.workspace.onDidOpenTextDocument(async (document) => {
      if (!isIndexableFile(document) || this.currentMode !== 'B') {
        return;
      }

      const content = document.getText();
      await this.indexFileContent(document.uri, content);
      await this.appendNativeIndexBatch([{ filePath: document.uri.fsPath, content }]);
    });

    const closeDisposable = vscode.workspace.onDidCloseTextDocument((document) => {
      if (this.currentMode !== 'B') {
        return;
      }

      const key = this.fileKey(document.uri);
      const existingTimer = this.fileCloseEvictionTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const evictionTimer = setTimeout(() => {
        this.indexByFile.delete(key);
        this.diagnosticsByFile.delete(key);
        this.importsByFile.delete(key);
        this.packageByFile.delete(key);
        this.fileCloseEvictionTimers.delete(key);
        void this.evictFileFromNativeIndex(document.uri.fsPath);
      }, SymbolIndexManager.FILE_CLOSE_EVICTION_DELAY_MS);

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
    this.modeCRebuildCompletedEmitter.dispose();
    this.stringTable.clear();
    this.indexByFile.clear();
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
    return this.indexByFile.get(this.fileKey(documentUri)) ?? [];
  }

  public getImportsForFile(documentUri: vscode.Uri): readonly ImportRecord[] {
    return this.importsByFile.get(this.fileKey(documentUri)) ?? [];
  }

  public getMemoryBudgetMetrics(): WorkspaceMemoryMetrics {
    let symbolCount = 0;
    for (const symbols of this.indexByFile.values()) {
      symbolCount += symbols.length;
    }

    const openFileCount = vscode.workspace.textDocuments.filter((document) => isIndexableFile(document)).length;

    return {
      fileCount: this.indexByFile.size,
      symbolCount,
      openFileCount,
      scalaLiteEstimatedHeapBytes: this.estimateScalaLiteHeapBytes()
    };
  }

  public async getMemoryBreakdown(): Promise<MemoryBreakdown> {
    const metrics = this.getMemoryBudgetMetrics();
    const importCount = Array.from(this.importsByFile.values()).reduce((sum, imports) => sum + imports.length, 0);
    const diagnosticCount = Array.from(this.diagnosticsByFile.values())
      .reduce((sum, diagnostics) => sum + diagnostics.length, 0);

    let nativeMemoryUsage: NativeMemoryUsage;
    try {
      nativeMemoryUsage = await this.getNativeEngine().getMemoryUsage();
    } catch {
      nativeMemoryUsage = {
        heapBytes: 0,
        accountedBytes: 0,
        estimatedOverheadBytes: 0,
        nativeRssBytes: 0,
        totalBytes: 0,
        includes: 'native memory unavailable',
        excludes: 'native engine metrics unavailable'
      };
    }

    return {
      fileCount: metrics.fileCount,
      symbolCount: metrics.symbolCount,
      importCount,
      diagnosticCount,
      contentCacheBytes: 0,
      estimatedJsHeapBytes: metrics.scalaLiteEstimatedHeapBytes,
      nativeMemoryUsage,
      stringTableEntries: this.stringTable.getStats().entryCount,
      stringTableBytes: this.stringTable.getStats().estimatedByteSavings
    };
  }

  private estimateScalaLiteHeapBytes(): number {
    let estimatedBytes = 0;

    for (const [fileKey, symbols] of this.indexByFile.entries()) {
      estimatedBytes += this.estimateStringBytes(fileKey);
      for (const symbol of symbols) {
        estimatedBytes += this.estimateIndexedSymbolBytes(symbol);
      }
    }

    for (const [fileKey, imports] of this.importsByFile.entries()) {
      estimatedBytes += this.estimateStringBytes(fileKey);
      for (const importEntry of imports) {
        estimatedBytes += this.estimateImportRecordBytes(importEntry);
      }
    }

    for (const [filePath, packageName] of this.packageByFile.entries()) {
      estimatedBytes += this.estimateStringBytes(filePath);
      estimatedBytes += this.estimateStringBytes(packageName);
    }

    for (const [filePath, diagnostics] of this.diagnosticsByFile.entries()) {
      estimatedBytes += this.estimateStringBytes(filePath);
      for (const diagnostic of diagnostics) {
        estimatedBytes += this.estimateNativeDiagnosticBytes(diagnostic);
      }
    }

    return Math.max(0, Math.round(estimatedBytes));
  }

  private estimateIndexedSymbolBytes(symbol: IndexedSymbol): number {
    let bytes = this.estimateStringBytes(symbol.symbolName);
    bytes += this.estimateStringBytes(symbol.symbolKind);
    bytes += this.estimateStringBytes(symbol.filePath);
    bytes += this.estimateNumberBytes();
    bytes += this.estimateStringBytes(symbol.packageName);
    bytes += this.estimateStringBytes(symbol.visibility);
    if (symbol.containerName) {
      bytes += this.estimateStringBytes(symbol.containerName);
    }

    return bytes;
  }

  private estimateImportRecordBytes(importRecord: ImportRecord): number {
    let bytes = this.estimateStringBytes(importRecord.packagePath);
    if (importRecord.importedName) {
      bytes += this.estimateStringBytes(importRecord.importedName);
    }
    if (importRecord.sourceSymbolName) {
      bytes += this.estimateStringBytes(importRecord.sourceSymbolName);
    }
    bytes += this.estimateBooleanBytes();
    bytes += this.estimateNumberBytes();

    return bytes;
  }

  private estimateNativeDiagnosticBytes(diagnostic: NativeDiagnostic): number {
    let bytes = this.estimateStringBytes(diagnostic.filePath);
    bytes += this.estimateNumberBytes();
    bytes += this.estimateNumberBytes();
    bytes += this.estimateStringBytes(diagnostic.severity);
    bytes += this.estimateStringBytes(diagnostic.message);

    return bytes;
  }

  private estimateStringBytes(value: string): number {
    return Buffer.byteLength(value, 'utf8');
  }

  private estimateNumberBytes(): number {
    return 8;
  }

  private estimateBooleanBytes(): number {
    return 4;
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
    this.stringTable.clear();
    this.indexByFile.clear();
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
      await this.syncNativeIndexFromUris(openTextDocuments.map((document) => document.uri), token);
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

    const batchSize = await readIndexBatchSizeFromWorkspaceConfig();
    const totalBatches = Math.max(1, Math.ceil(filteredFiles.length / batchSize));

    await this.clearNativeIndex(token);

    let cancelled = false;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Scala Lite: Rebuilding index'),
        cancellable: true
      },
      async (progress, progressToken) => {
        for (let start = 0; start < filteredFiles.length; start += batchSize) {
          if (token?.isCancellationRequested || progressToken.isCancellationRequested) {
            this.logger.info('INDEX', 'Mode C index rebuild cancelled.');
            cancelled = true;
            return;
          }

          const batchNumber = Math.floor(start / batchSize) + 1;
          progress.report({
            message: vscode.l10n.t('Indexing batch {0}/{1}…', String(batchNumber), String(totalBatches))
          });

          const batch = filteredFiles.slice(start, start + batchSize);
          const nativeBatch: Array<{ filePath: string; content: string }> = [];

          for (const fileUri of batch) {
            if (token?.isCancellationRequested || progressToken.isCancellationRequested) {
              this.logger.info('INDEX', 'Mode C index rebuild cancelled.');
              cancelled = true;
              return;
            }

            try {
              const content = await this.readFileContent(fileUri);
              await this.indexFileContent(fileUri, content, token);
              nativeBatch.push({ filePath: fileUri.fsPath, content });
            } catch {
            }
          }

          await this.appendNativeIndexBatch(nativeBatch, token);
        }
      }
    );

    if (token?.isCancellationRequested || cancelled) {
      this.logger.info('INDEX', 'Mode C index rebuild cancelled.');
      return;
    }

    this.logger.debug('INDEX', `Mode C rebuild completed with ${this.indexByFile.size} indexed file(s).`);
    this.modeCRebuildCompletedEmitter.fire();

    this.logger.info('INDEX', `Mode C index rebuilt from ${filteredFiles.length} file(s).`);
  }

  private async indexDocument(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<void> {
    await this.indexFileContent(document.uri, document.getText(), token);
  }

  private async indexFileContent(fileUri: vscode.Uri, content: string, token?: vscode.CancellationToken): Promise<void> {
    const parsed = await this.tryParseWithNative(fileUri.fsPath, content, token);
    const symbols = (parsed?.symbols ?? extractSymbolsFromContent(fileUri.fsPath, content))
      .filter((symbol) => isValidIndexedSymbol(symbol))
      .map((symbol) => ({
        ...symbol,
        filePath: this.stringTable.intern(symbol.filePath),
        packageName: this.stringTable.intern(symbol.packageName),
        containerName: symbol.containerName ? this.stringTable.intern(symbol.containerName) : undefined
      }));
    const imports = parsed?.imports ?? [];
    this.logger.debug(
      'INDEX',
      `Indexed ${fileUri.fsPath} with ${symbols.length} symbol(s) using ${parsed ? 'native' : 'typescript'} parser.`
    );
    const key = this.fileKey(fileUri);
    this.indexByFile.set(key, [...symbols]);
    this.importsByFile.set(key, [...imports]);
    const packageSymbol = symbols.find((symbol) => symbol.symbolKind === 'package');
    if (packageSymbol) {
      this.packageByFile.set(key, packageSymbol.packageName || packageSymbol.symbolName);
    } else {
      this.packageByFile.delete(key);
    }
    this.diagnosticsByFile.set(key, [...(parsed?.diagnostics ?? [])]);
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

  private async syncNativeIndexFromUris(fileUris: readonly vscode.Uri[], token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) {
      return;
    }

    await this.clearNativeIndex(token);

    const configuredBatchSize = await readIndexBatchSizeFromWorkspaceConfig();
    const batchSize = configuredBatchSize > 0
      ? configuredBatchSize
      : SymbolIndexManager.DEFAULT_NATIVE_SYNC_BATCH_SIZE;

    for (let start = 0; start < fileUris.length; start += batchSize) {
      if (token?.isCancellationRequested) {
        return;
      }

      const batch = fileUris.slice(start, start + batchSize);
      const nativeBatch: Array<{ filePath: string; content: string }> = [];

      for (const fileUri of batch) {
        if (token?.isCancellationRequested) {
          this.logger.info('INDEX', 'Mode C index rebuild cancelled.');
          return;
        }

        try {
          const content = await this.readFileContent(fileUri);
          nativeBatch.push({ filePath: fileUri.fsPath, content });
        } catch {
        }
      }

      await this.appendNativeIndexBatch(nativeBatch, token);
    }
  }

  private async appendNativeIndexBatch(
    files: readonly { filePath: string; content: string }[],
    token?: vscode.CancellationToken
  ): Promise<void> {
    if (token?.isCancellationRequested || files.length === 0) {
      return;
    }

    try {
      const total = await this.getNativeEngine().appendFiles(files, token);
      this.logger.debug('INDEX', `Native append sync completed for ${files.length} file(s), ${total} symbol(s) total.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native append_files failed. Continuing with TypeScript index fallback. ${message}`);
    }
  }

  private async clearNativeIndex(token?: vscode.CancellationToken): Promise<void> {
    if (token?.isCancellationRequested) {
      return;
    }

    try {
      await this.getNativeEngine().clearIndex(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('INDEX', `Native clear_index failed. Continuing with TypeScript index fallback. ${message}`);
    }
  }

  private async readFileContent(fileUri: vscode.Uri): Promise<string> {
    const activeDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === fileUri.toString());
    if (activeDocument) {
      return activeDocument.getText();
    }

    const bytes = await vscode.workspace.fs.readFile(fileUri);
    return Buffer.from(bytes).toString('utf8');
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
