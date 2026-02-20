import * as path from 'node:path';
import * as vscode from 'vscode';
import { IndexedSymbol } from './symbolIndex';

export type NativeEngineStatus = 'active' | 'fallback' | 'crashed' | 'restarting';

export interface NativeMemoryUsage {
  readonly heapBytes: number;
  readonly nativeRssBytes: number;
  readonly totalBytes: number;
}

export interface NativeParseResult {
  readonly symbols: readonly IndexedSymbol[];
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

class TypeScriptFallbackEngine {
  private readonly symbolsByName = new Map<string, IndexedSymbol[]>();
  private readonly diagnosticsByFile = new Map<string, NativeDiagnostic[]>();

  public parseFile(filePath: string, content: string): NativeParseResult {
    const symbols = this.extractSymbols(filePath, content);
    const diagnostics = this.extractDiagnostics(filePath, content);

    return {
      symbols,
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
    const normalizedQuery = query.trim().toLowerCase();
    const ranked: Array<{ score: number; symbol: IndexedSymbol }> = [];

    for (const [symbolName, symbols] of this.symbolsByName.entries()) {
      const score = this.fuzzyScore(normalizedQuery, symbolName.toLowerCase());
      if (score === undefined || symbols.length === 0) {
        continue;
      }

      ranked.push({ score, symbol: symbols[0] });
    }

    ranked.sort((left, right) => right.score - left.score);
    return ranked.slice(0, Math.max(1, limit)).map((entry) => entry.symbol);
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
          lineNumber: index + 1
        });
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

function loadNativeAddon(): AddonLoadResult {
  const candidatePaths = [
    path.resolve(__dirname, '..', 'native', 'scala-lite-engine', 'bindings', platformBinaryFileName()),
    path.resolve(__dirname, '..', 'native', 'scala-lite-engine', 'index.node')
  ];

  const loadErrors: string[] = [];

  for (const candidate of candidatePaths) {
    try {
      const loaded = require(candidate) as NativeAddonApi;
      return {
        addon: loaded,
        source: 'native'
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      loadErrors.push(`${candidate}: ${reason}`);
    }
  }

  try {
    const wasmModulePath = path.resolve(__dirname, '..', 'native', 'scala-lite-engine', 'pkg', 'scala_lite_engine_wasm.js');
    const loaded = require(wasmModulePath) as NativeAddonApi;
    return {
      addon: loaded,
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
