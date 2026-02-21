import * as path from 'node:path';
import * as vscode from 'vscode';
import { ImportRecord, IndexedSymbol } from './symbolIndex';
import { compareSymbols } from './symbolSort';

export type NativeEngineStatus = 'active' | 'fallback' | 'crashed' | 'restarting';

export interface NativeMemoryUsage {
  readonly heapBytes: number;
  readonly nativeRssBytes: number;
  readonly totalBytes: number;
}

export interface NativeParseResult {
  readonly symbols: readonly IndexedSymbol[];
  readonly imports: readonly ImportRecord[];
  readonly diagnostics: readonly NativeDiagnostic[];
}

export interface NativeDiagnostic {
  readonly filePath: string;
  readonly lineNumber: number;
  readonly column: number;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export class NativeEngineUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NativeEngineUnavailableError';
  }
}

export class NativeEngineCrashError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'NativeEngineCrashError';
  }
}

interface NativeAddonApi {
  parse_file(filePath: string, content: string): NativeParseResult;
  index_files(files: readonly { filePath: string; content: string }[]): number;
  query_symbols(query: string, limit: number): readonly IndexedSymbol[];
  query_symbols_in_package(query: string, packagePath: string, limit: number): readonly IndexedSymbol[];
  query_package_exists(packagePath: string): boolean;
  get_diagnostics(filePath: string): readonly NativeDiagnostic[];
  evict_file(filePath: string): void;
  rebuild_index(files: readonly { filePath: string; content: string }[]): number;
  get_memory_usage(): { heapBytes?: number; heap_bytes?: number; nativeRssBytes?: number; native_rss_bytes?: number; totalBytes?: number; total_bytes?: number };
  shutdown(): void;
}

interface AddonLoadResult {
  readonly addon: NativeAddonApi;
  readonly source: 'native' | 'wasm';
}

type NativeAddonMethodMap = {
  readonly parseFile?: (filePath: string, content: string) => NativeParseResult;
  readonly parse_file?: (filePath: string, content: string) => NativeParseResult;
  readonly indexFiles?: (files: readonly { filePath: string; content: string }[]) => number;
  readonly index_files?: (files: readonly { filePath: string; content: string }[]) => number;
  readonly querySymbols?: (query: string, limit: number) => readonly IndexedSymbol[];
  readonly query_symbols?: (query: string, limit: number) => readonly IndexedSymbol[];
  readonly querySymbolsInPackage?: (query: string, packagePath: string, limit: number) => readonly IndexedSymbol[];
  readonly query_symbols_in_package?: (query: string, packagePath: string, limit: number) => readonly IndexedSymbol[];
  readonly queryPackageExists?: (packagePath: string) => boolean;
  readonly query_package_exists?: (packagePath: string) => boolean;
  readonly getDiagnostics?: (filePath: string) => readonly NativeDiagnostic[];
  readonly get_diagnostics?: (filePath: string) => readonly NativeDiagnostic[];
  readonly evictFile?: (filePath: string) => void;
  readonly evict_file?: (filePath: string) => void;
  readonly rebuildIndex?: (files: readonly { filePath: string; content: string }[]) => number;
  readonly rebuild_index?: (files: readonly { filePath: string; content: string }[]) => number;
  readonly getMemoryUsage?: () => {
    heapBytes?: number;
    heap_bytes?: number;
    nativeRssBytes?: number;
    native_rss_bytes?: number;
    totalBytes?: number;
    total_bytes?: number;
  };
  readonly get_memory_usage?: () => {
    heapBytes?: number;
    heap_bytes?: number;
    nativeRssBytes?: number;
    native_rss_bytes?: number;
    totalBytes?: number;
    total_bytes?: number;
  };
  readonly shutdown?: () => void;
};

interface RawNativeSymbol {
  readonly symbolName?: string;
  readonly symbol_kind?: string;
  readonly symbolKind?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly filePath?: string;
  readonly file_path?: string;
  readonly lineNumber?: number;
  readonly line_number?: number;
  readonly containerName?: string;
  readonly container_name?: string | null;
  readonly packageName?: string;
  readonly package_name?: string;
  readonly visibility?: string;
}

interface RawNativeDiagnostic {
  readonly filePath?: string;
  readonly file_path?: string;
  readonly lineNumber?: number;
  readonly line_number?: number;
  readonly column?: number;
  readonly severity?: string;
  readonly message?: string;
}

interface RawNativeParseResult {
  readonly symbols?: readonly RawNativeSymbol[];
  readonly imports?: readonly RawNativeImport[];
  readonly diagnostics?: readonly RawNativeDiagnostic[];
}

interface RawNativeImport {
  readonly filePath?: string;
  readonly file_path?: string;
  readonly packagePath?: string;
  readonly package_path?: string;
  readonly importedName?: string;
  readonly imported_name?: string;
  readonly sourceSymbolName?: string;
  readonly source_symbol_name?: string;
  readonly isWildcard?: boolean;
  readonly is_wildcard?: boolean;
  readonly lineNumber?: number;
  readonly line_number?: number;
}

class TypeScriptFallbackEngine {
  private readonly symbolsByName = new Map<string, IndexedSymbol[]>();
  private readonly diagnosticsByFile = new Map<string, NativeDiagnostic[]>();

  public parseFile(filePath: string, content: string): NativeParseResult {
    const symbols = this.extractSymbols(filePath, content);
    const diagnostics = this.extractDiagnostics(filePath, content);

    return {
      symbols,
      imports: [],
      diagnostics
    };
  }

  public indexFiles(files: readonly { filePath: string; content: string }[]): number {
    this.symbolsByName.clear();
    this.diagnosticsByFile.clear();

    for (const file of files) {
      const parsed = this.parseFile(file.filePath, file.content);
      for (const symbol of parsed.symbols) {
        const existing = this.symbolsByName.get(symbol.symbolName) ?? [];
        existing.push(symbol);
        this.symbolsByName.set(symbol.symbolName, existing);
      }

      this.diagnosticsByFile.set(file.filePath, [...parsed.diagnostics]);
    }

    return Array.from(this.symbolsByName.values()).reduce((sum, symbols) => sum + symbols.length, 0);
  }

  public querySymbols(query: string, limit: number): readonly IndexedSymbol[] {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return [];
    }

    const cappedLimit = Math.max(1, Math.floor(limit));
    const exactBucket = this.symbolsByName.get(trimmedQuery);
    if (exactBucket && exactBucket.length > 0) {
      return [...exactBucket]
        .sort((left, right) => compareSymbols(left, right))
        .slice(0, cappedLimit);
    }

    const normalizedQuery = trimmedQuery.toLowerCase();
    const rankedBuckets: Array<{ score: number; symbolName: string; symbols: readonly IndexedSymbol[] }> = [];

    for (const [symbolName, symbols] of this.symbolsByName.entries()) {
      const score = this.fuzzyScore(normalizedQuery, symbolName.toLowerCase());
      if (score === undefined || symbols.length === 0) {
        continue;
      }

      rankedBuckets.push({
        score,
        symbolName,
        symbols: [...symbols].sort((left, right) => compareSymbols(left, right))
      });
    }

    rankedBuckets.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.symbolName.localeCompare(right.symbolName);
    });

    return rankedBuckets
      .flatMap((bucket) => bucket.symbols)
      .slice(0, cappedLimit);
  }

  public querySymbolsInPackage(query: string, packagePath: string, limit: number): readonly IndexedSymbol[] {
    const trimmedQuery = query.trim();
    const trimmedPackagePath = packagePath.trim();
    if (!trimmedQuery || !trimmedPackagePath) {
      return [];
    }

    const cappedLimit = Math.max(1, Math.floor(limit));
    const exactBucket = this.symbolsByName.get(trimmedQuery);
    if (!exactBucket || exactBucket.length === 0) {
      return [];
    }

    return exactBucket
      .filter((entry) => entry.packageName === trimmedPackagePath)
      .sort((left, right) => compareSymbols(left, right))
      .slice(0, cappedLimit);
  }

  public queryPackageExists(packagePath: string): boolean {
    const trimmedPath = packagePath.trim();
    if (!trimmedPath) {
      return false;
    }

    for (const symbols of this.symbolsByName.values()) {
      if (symbols.some((symbol) => symbol.packageName === trimmedPath)) {
        return true;
      }
    }

    return false;
  }

  public getDiagnostics(filePath: string): readonly NativeDiagnostic[] {
    return this.diagnosticsByFile.get(filePath) ?? [];
  }

  public evictFile(filePath: string): void {
    this.diagnosticsByFile.delete(filePath);
    for (const [key, symbols] of this.symbolsByName.entries()) {
      const filtered = symbols.filter((symbol) => symbol.filePath !== filePath);
      if (filtered.length === 0) {
        this.symbolsByName.delete(key);
        continue;
      }

      this.symbolsByName.set(key, filtered);
    }
  }

  public rebuildIndex(files: readonly { filePath: string; content: string }[]): number {
    return this.indexFiles(files);
  }

  public getMemoryUsage(): NativeMemoryUsage {
    const symbolCount = Array.from(this.symbolsByName.values()).reduce((sum, symbols) => sum + symbols.length, 0);
    const diagnosticCount = Array.from(this.diagnosticsByFile.values()).reduce((sum, diagnostics) => sum + diagnostics.length, 0);
    const nativeRssBytes = (symbolCount * 64) + (diagnosticCount * 96);

    return {
      heapBytes: 0,
      nativeRssBytes,
      totalBytes: nativeRssBytes
    };
  }

  public shutdown(): void {
    this.symbolsByName.clear();
    this.diagnosticsByFile.clear();
  }

  private extractSymbols(filePath: string, content: string): IndexedSymbol[] {
    const symbols: IndexedSymbol[] = [];
    const lines = content.split(/\r?\n/);
    let currentPackageName = '';

    const inferVisibility = (lineText: string): IndexedSymbol['visibility'] => {
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

    const regexByKind: Array<{ kind: IndexedSymbol['symbolKind']; regex: RegExp }> = [
      { kind: 'package', regex: /^\s*package\s+([A-Za-z0-9_.]+)/ },
      { kind: 'object', regex: /^\s*object\s+([A-Za-z0-9_]+)/ },
      { kind: 'class', regex: /^\s*(?:final\s+|sealed\s+|abstract\s+)*class\s+([A-Za-z0-9_]+)/ },
      { kind: 'trait', regex: /^\s*(?:sealed\s+)?trait\s+([A-Za-z0-9_]+)/ },
      { kind: 'def', regex: /^\s*(?:override\s+|private\s+|protected\s+)*def\s+([A-Za-z0-9_]+)/ },
      { kind: 'val', regex: /^\s*(?:private\s+|protected\s+)*val\s+([A-Za-z0-9_]+)/ },
      { kind: 'type', regex: /^\s*type\s+([A-Za-z0-9_]+)/ }
    ];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const entry of regexByKind) {
        const match = line.match(entry.regex);
        if (!match?.[1]) {
          continue;
        }

        symbols.push({
          symbolName: match[1],
          symbolKind: entry.kind,
          filePath,
          lineNumber: index + 1,
          packageName: entry.kind === 'package' ? (currentPackageName || match[1]) : currentPackageName,
          visibility: inferVisibility(line)
        });

        if (entry.kind === 'package' && !currentPackageName) {
          currentPackageName = match[1];
        }
      }
    }

    return symbols;
  }

  private extractDiagnostics(filePath: string, content: string): NativeDiagnostic[] {
    const diagnostics: NativeDiagnostic[] = [];

    const openBraces = (content.match(/\{/g) ?? []).length;
    const closeBraces = (content.match(/\}/g) ?? []).length;
    const openParens = (content.match(/\(/g) ?? []).length;
    const closeParens = (content.match(/\)/g) ?? []).length;
    const quotes = (content.match(/"/g) ?? []).length;

    if (openBraces !== closeBraces || openParens !== closeParens) {
      diagnostics.push({
        filePath,
        lineNumber: Math.max(1, content.split(/\r?\n/).length),
        column: 1,
        severity: 'error',
        message: 'Unmatched delimiter detected.'
      });
    }

    if (quotes % 2 !== 0) {
      diagnostics.push({
        filePath,
        lineNumber: Math.max(1, content.split(/\r?\n/).length),
        column: 1,
        severity: 'error',
        message: 'Unterminated string literal.'
      });
    }

    return diagnostics;
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

}

function platformBinaryFileName(): string {
  const platform = process.platform;
  const arch = process.arch;
  return `scala-lite-engine.${platform}-${arch}.node`;
}

function normalizeSymbolKind(kind: string | undefined): IndexedSymbol['symbolKind'] {
  if (kind === 'package' || kind === 'object' || kind === 'class' || kind === 'trait' || kind === 'def' || kind === 'val' || kind === 'type' || kind === 'param') {
    return kind;
  }

  if (kind === 'var' || kind === 'given') {
    return 'val';
  }

  if (kind === 'enum') {
    return 'type';
  }

  return 'def';
}

function normalizeNativeSymbol(raw: RawNativeSymbol): IndexedSymbol | undefined {
  const symbolName = typeof raw.symbolName === 'string' && raw.symbolName.length > 0
    ? raw.symbolName
    : raw.name;
  const filePath = typeof raw.filePath === 'string' && raw.filePath.length > 0
    ? raw.filePath
    : raw.file_path;
  const lineNumber = typeof raw.lineNumber === 'number' ? raw.lineNumber : raw.line_number;

  if (!symbolName || !filePath || typeof lineNumber !== 'number' || !Number.isFinite(lineNumber)) {
    return undefined;
  }

  const rawKind = typeof raw.symbolKind === 'string'
    ? raw.symbolKind
    : (typeof raw.symbol_kind === 'string' ? raw.symbol_kind : raw.kind);
  const containerName = typeof raw.containerName === 'string'
    ? raw.containerName
    : (typeof raw.container_name === 'string' ? raw.container_name : undefined);
  const packageName = typeof raw.packageName === 'string'
    ? raw.packageName
    : (typeof raw.package_name === 'string' ? raw.package_name : '');
  const visibility = raw.visibility === 'public' || raw.visibility === 'protected' || raw.visibility === 'private' || raw.visibility === 'unknown'
    ? raw.visibility
    : 'unknown';

  return {
    symbolName,
    symbolKind: normalizeSymbolKind(rawKind),
    filePath,
    lineNumber: Math.max(1, Math.round(lineNumber)),
    packageName,
    visibility,
    containerName
  };
}

function normalizeNativeDiagnostic(raw: RawNativeDiagnostic): NativeDiagnostic | undefined {
  const filePath = typeof raw.filePath === 'string' && raw.filePath.length > 0
    ? raw.filePath
    : raw.file_path;
  const lineNumber = typeof raw.lineNumber === 'number' ? raw.lineNumber : raw.line_number;
  const column = typeof raw.column === 'number' && Number.isFinite(raw.column) ? raw.column : 1;

  if (!filePath || typeof lineNumber !== 'number' || !Number.isFinite(lineNumber)) {
    return undefined;
  }

  return {
    filePath,
    lineNumber: Math.max(1, Math.round(lineNumber)),
    column: Math.max(1, Math.round(column)),
    severity: raw.severity === 'warning' ? 'warning' : 'error',
    message: typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : 'Native diagnostic'
  };
}

function normalizeNativeParseResult(raw: RawNativeParseResult): NativeParseResult {
  const symbols = (raw.symbols ?? [])
    .map((entry) => normalizeNativeSymbol(entry))
    .filter((entry): entry is IndexedSymbol => entry !== undefined);
  const imports = (raw.imports ?? [])
    .map((entry) => normalizeNativeImport(entry))
    .filter((entry): entry is ImportRecord => entry !== undefined);
  const diagnostics = (raw.diagnostics ?? [])
    .map((entry) => normalizeNativeDiagnostic(entry))
    .filter((entry): entry is NativeDiagnostic => entry !== undefined);

  return {
    symbols,
    imports,
    diagnostics
  };
}

function normalizeNativeImport(raw: RawNativeImport): ImportRecord | undefined {
  const filePath = typeof raw.filePath === 'string' && raw.filePath.length > 0
    ? raw.filePath
    : raw.file_path;
  const packagePath = typeof raw.packagePath === 'string' && raw.packagePath.length > 0
    ? raw.packagePath
    : raw.package_path;
  const importedName = typeof raw.importedName === 'string' && raw.importedName.length > 0
    ? raw.importedName
    : raw.imported_name;
  const sourceSymbolName = typeof raw.sourceSymbolName === 'string' && raw.sourceSymbolName.length > 0
    ? raw.sourceSymbolName
    : raw.source_symbol_name;
  const isWildcard = typeof raw.isWildcard === 'boolean'
    ? raw.isWildcard
    : (typeof raw.is_wildcard === 'boolean' ? raw.is_wildcard : false);
  const lineNumber = typeof raw.lineNumber === 'number' ? raw.lineNumber : raw.line_number;

  if (!filePath || !packagePath || typeof lineNumber !== 'number' || !Number.isFinite(lineNumber)) {
    return undefined;
  }

  return {
    packagePath,
    importedName,
    sourceSymbolName,
    isWildcard,
    lineNumber: Math.max(1, Math.round(lineNumber))
  };
}

function normalizeNativeSymbolArray(raw: readonly RawNativeSymbol[]): readonly IndexedSymbol[] {
  return raw
    .map((entry) => normalizeNativeSymbol(entry))
    .filter((entry): entry is IndexedSymbol => entry !== undefined);
}

function normalizeNativeDiagnosticArray(raw: readonly RawNativeDiagnostic[]): readonly NativeDiagnostic[] {
  return raw
    .map((entry) => normalizeNativeDiagnostic(entry))
    .filter((entry): entry is NativeDiagnostic => entry !== undefined);
}

function resolveNativeAddonApi(moduleExports: unknown): NativeAddonApi | undefined {
  if (!moduleExports || (typeof moduleExports !== 'object' && typeof moduleExports !== 'function')) {
    return undefined;
  }

  const exportsRecord = moduleExports as Record<string, unknown>;
  const instance: unknown = typeof exportsRecord.NativeEngine === 'function'
    ? new (exportsRecord.NativeEngine as new () => unknown)()
    : moduleExports;

  if (!instance || typeof instance !== 'object') {
    return undefined;
  }

  const methods = instance as NativeAddonMethodMap;

  const parseFile = methods.parse_file ?? methods.parseFile;
  const indexFiles = methods.index_files ?? methods.indexFiles;
  const querySymbols = methods.query_symbols ?? methods.querySymbols;
  const querySymbolsInPackage = methods.query_symbols_in_package ?? methods.querySymbolsInPackage;
  const queryPackageExists = methods.query_package_exists ?? methods.queryPackageExists;
  const getDiagnostics = methods.get_diagnostics ?? methods.getDiagnostics;
  const evictFile = methods.evict_file ?? methods.evictFile;
  const rebuildIndex = methods.rebuild_index ?? methods.rebuildIndex;
  const getMemoryUsage = methods.get_memory_usage ?? methods.getMemoryUsage;
  const shutdown = methods.shutdown;

  if (
    typeof parseFile !== 'function'
    || typeof indexFiles !== 'function'
    || typeof querySymbols !== 'function'
    || typeof querySymbolsInPackage !== 'function'
    || typeof queryPackageExists !== 'function'
    || typeof getDiagnostics !== 'function'
    || typeof evictFile !== 'function'
    || typeof rebuildIndex !== 'function'
    || typeof getMemoryUsage !== 'function'
    || typeof shutdown !== 'function'
  ) {
    return undefined;
  }

  return {
    parse_file: (filePath: string, content: string) => {
      const parsed = parseFile.call(instance, filePath, content) as RawNativeParseResult;
      return normalizeNativeParseResult(parsed);
    },
    index_files: (files: readonly { filePath: string; content: string }[]) => indexFiles.call(instance, files),
    query_symbols: (query: string, limit: number) => {
      const symbols = querySymbols.call(instance, query, limit) as readonly RawNativeSymbol[];
      return normalizeNativeSymbolArray(symbols);
    },
    query_symbols_in_package: (query: string, packagePath: string, limit: number) => {
      const symbols = querySymbolsInPackage.call(instance, query, packagePath, limit) as readonly RawNativeSymbol[];
      return normalizeNativeSymbolArray(symbols);
    },
    query_package_exists: (packagePath: string) => queryPackageExists.call(instance, packagePath) as boolean,
    get_diagnostics: (filePath: string) => {
      const diagnostics = getDiagnostics.call(instance, filePath) as readonly RawNativeDiagnostic[];
      return normalizeNativeDiagnosticArray(diagnostics);
    },
    evict_file: (filePath: string) => evictFile.call(instance, filePath),
    rebuild_index: (files: readonly { filePath: string; content: string }[]) => rebuildIndex.call(instance, files),
    get_memory_usage: () => getMemoryUsage.call(instance),
    shutdown: () => shutdown.call(instance)
  };
}

function loadNativeAddon(): AddonLoadResult {
  const candidatePaths = [
    path.resolve(__dirname, '..', 'native', 'scala-lite-engine', platformBinaryFileName()),
    path.resolve(__dirname, '..', 'native', 'scala-lite-engine', 'bindings', platformBinaryFileName()),
    path.resolve(__dirname, '..', 'native', 'scala-lite-engine', 'index.node')
  ];

  const loadErrors: string[] = [];

  for (const candidate of candidatePaths) {
    try {
      const loaded = require(candidate) as unknown;
      const addon = resolveNativeAddonApi(loaded);
      if (!addon) {
        throw new Error('Loaded native addon has unsupported API shape.');
      }
      return {
        addon,
        source: 'native'
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      loadErrors.push(`${candidate}: ${reason}`);
    }
  }

  try {
    const wasmModulePath = path.resolve(__dirname, '..', 'native', 'scala-lite-engine', 'pkg', 'scala_lite_engine_wasm.js');
    const loaded = require(wasmModulePath) as unknown;
    const addon = resolveNativeAddonApi(loaded);
    if (!addon) {
      throw new Error('Loaded WASM addon has unsupported API shape.');
    }
    return {
      addon,
      source: 'wasm'
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    loadErrors.push(`wasm: ${reason}`);
  }

  throw new NativeEngineUnavailableError(
    `Unable to load native addon from platform binary or WASM fallback. ${loadErrors.join(' | ')}`
  );
}

export class NativeEngine {
  public status: NativeEngineStatus;
  private readonly fallback: TypeScriptFallbackEngine;
  private addon: NativeAddonApi | undefined;

  private constructor(status: NativeEngineStatus, addon: NativeAddonApi | undefined) {
    this.status = status;
    this.addon = addon;
    this.fallback = new TypeScriptFallbackEngine();
  }

  public static create(): NativeEngine {
    const loaded = loadNativeAddon();
    const status: NativeEngineStatus = loaded.source === 'native' ? 'active' : 'fallback';
    return new NativeEngine(status, loaded.addon);
  }

  public static createFallback(): NativeEngine {
    return new NativeEngine('fallback', undefined);
  }

  public async parseFile(
    filePath: string,
    content: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<NativeParseResult> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.parseFile(filePath, content);
      }

      return this.addon.parse_file(filePath, content);
    }, cancellationToken);
  }

  public async indexFiles(
    files: readonly { filePath: string; content: string }[],
    cancellationToken?: vscode.CancellationToken
  ): Promise<number> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.indexFiles(files);
      }

      return this.addon.index_files(files);
    }, cancellationToken);
  }

  public async querySymbols(
    query: string,
    limit = 200,
    cancellationToken?: vscode.CancellationToken
  ): Promise<readonly IndexedSymbol[]> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.querySymbols(query, limit);
      }

      return this.addon.query_symbols(query, limit);
    }, cancellationToken);
  }

  public async querySymbolsInPackage(
    query: string,
    packagePath: string,
    limit = 200,
    cancellationToken?: vscode.CancellationToken
  ): Promise<readonly IndexedSymbol[]> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.querySymbolsInPackage(query, packagePath, limit);
      }

      return this.addon.query_symbols_in_package(query, packagePath, limit);
    }, cancellationToken);
  }

  public async queryPackageExists(
    packagePath: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<boolean> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.queryPackageExists(packagePath);
      }

      return this.addon.query_package_exists(packagePath);
    }, cancellationToken);
  }

  public async getDiagnostics(
    filePath: string,
    cancellationToken?: vscode.CancellationToken
  ): Promise<readonly NativeDiagnostic[]> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.getDiagnostics(filePath);
      }

      return this.addon.get_diagnostics(filePath);
    }, cancellationToken);
  }

  public async evictFile(filePath: string): Promise<void> {
    if (!this.addon) {
      this.fallback.evictFile(filePath);
      return;
    }

    this.addon.evict_file(filePath);
  }

  public async rebuildIndex(
    files: readonly { filePath: string; content: string }[],
    cancellationToken?: vscode.CancellationToken
  ): Promise<number> {
    return this.withCancellation(async () => {
      if (!this.addon) {
        return this.fallback.rebuildIndex(files);
      }

      return this.addon.rebuild_index(files);
    }, cancellationToken);
  }

  public async getMemoryUsage(): Promise<NativeMemoryUsage> {
    if (!this.addon) {
      return this.fallback.getMemoryUsage();
    }

    const raw = this.addon.get_memory_usage();
    const heapBytes = raw.heapBytes ?? raw.heap_bytes ?? 0;
    const nativeRssBytes = raw.nativeRssBytes ?? raw.native_rss_bytes ?? 0;
    const totalBytes = raw.totalBytes ?? raw.total_bytes ?? (heapBytes + nativeRssBytes);

    return {
      heapBytes,
      nativeRssBytes,
      totalBytes
    };
  }

  public async shutdown(): Promise<void> {
    try {
      if (this.addon) {
        this.addon.shutdown();
      } else {
        this.fallback.shutdown();
      }
    } catch (error) {
      this.status = 'crashed';
      throw new NativeEngineCrashError(error instanceof Error ? error.message : String(error));
    }
  }

  public async restart(): Promise<void> {
    this.status = 'restarting';
    await this.shutdown();

    try {
      const rebuilt = NativeEngine.create();
      this.status = rebuilt.status;
      this.addon = rebuilt.addon;
      return;
    } catch {
      this.status = 'fallback';
      this.addon = undefined;
    }
  }

  private async withCancellation<T>(
    executor: () => Promise<T> | T,
    cancellationToken?: vscode.CancellationToken
  ): Promise<T> {
    if (cancellationToken?.isCancellationRequested) {
      throw new Error('Operation cancelled before execution.');
    }

    let cancellationDisposable: vscode.Disposable | undefined;
    let cancelled = false;

    if (cancellationToken) {
      cancellationDisposable = cancellationToken.onCancellationRequested(() => {
        cancelled = true;
      });
    }

    try {
      const value = await executor();
      if (cancelled) {
        throw new Error('Operation cancelled.');
      }

      return value;
    } catch (error) {
      if (cancelled) {
        throw new Error('Operation cancelled.', { cause: error });
      }

      if (error instanceof Error && error.message.toLowerCase().includes('cancel')) {
        throw error;
      }

      this.status = 'crashed';
      throw new NativeEngineCrashError(error instanceof Error ? error.message : String(error), { cause: error });
    } finally {
      cancellationDisposable?.dispose();
    }
  }
}
