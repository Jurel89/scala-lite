import * as vscode from 'vscode';
import * as path from 'node:path';
import { WorkspaceMode } from './modePresentation';
import { IndexedSymbol, SymbolIndexManager } from './symbolIndex';

interface RankedSymbol {
  readonly symbol: IndexedSymbol;
  readonly prefixRank: number;
  readonly fuzzyScore: number;
  readonly recencyScore: number;
}

function toSymbolKind(kind: IndexedSymbol['symbolKind']): vscode.SymbolKind {
  if (kind === 'package') {
    return vscode.SymbolKind.Package;
  }

  if (kind === 'object') {
    return vscode.SymbolKind.Object;
  }

  if (kind === 'class') {
    return vscode.SymbolKind.Class;
  }

  if (kind === 'trait') {
    return vscode.SymbolKind.Interface;
  }

  if (kind === 'def') {
    return vscode.SymbolKind.Method;
  }

  if (kind === 'val') {
    return vscode.SymbolKind.Variable;
  }

  return vscode.SymbolKind.TypeParameter;
}

function subsequenceScore(query: string, candidate: string): number | undefined {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedCandidate = candidate.toLowerCase();

  if (!normalizedQuery) {
    return 0;
  }

  let score = 0;
  let cursor = 0;
  let previousMatch = -1;

  for (let index = 0; index < normalizedQuery.length; index += 1) {
    const char = normalizedQuery[index];
    const foundAt = normalizedCandidate.indexOf(char, cursor);
    if (foundAt === -1) {
      return undefined;
    }

    score += 20;
    if (foundAt === previousMatch + 1) {
      score += 15;
    }

    if (index === 0 && foundAt === 0) {
      score += 80;
    } else {
      score += Math.max(0, 20 - foundAt);
    }

    previousMatch = foundAt;
    cursor = foundAt + 1;
  }

  score += Math.max(0, 30 - Math.max(0, normalizedCandidate.length - normalizedQuery.length));
  return score;
}

export class WorkspaceSymbolSearchProvider implements vscode.WorkspaceSymbolProvider {
  private readonly symbolIndexManager: SymbolIndexManager;
  private readonly getMode: () => WorkspaceMode;
  private readonly fileRecency = new Map<string, number>();

  public constructor(symbolIndexManager: SymbolIndexManager, getMode: () => WorkspaceMode) {
    this.symbolIndexManager = symbolIndexManager;
    this.getMode = getMode;
  }

  public recordFileAccess(uri: vscode.Uri): void {
    this.fileRecency.set(uri.fsPath, Date.now());
  }

  public async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    if (token.isCancellationRequested) {
      return [];
    }

    const mode = this.getMode();
    if (mode === 'A') {
      return [];
    }

    const normalizedQuery = query.trim().toLowerCase();
    const allSymbols = normalizedQuery.length === 0
      ? this.symbolIndexManager.getAllSymbols()
      : await this.symbolIndexManager.searchSymbols(normalizedQuery, 300, token);
    const ranked: RankedSymbol[] = [];

    for (const symbol of allSymbols) {
      if (token.isCancellationRequested) {
        return [];
      }

      const normalizedName = symbol.symbolName.toLowerCase();
      const score = normalizedQuery.length === 0 ? 0 : subsequenceScore(normalizedQuery, normalizedName);
      if (score === undefined) {
        continue;
      }

      ranked.push({
        symbol,
        prefixRank: normalizedName.startsWith(normalizedQuery) ? 0 : 1,
        fuzzyScore: score,
        recencyScore: this.fileRecency.get(symbol.filePath) ?? 0
      });
    }

    ranked.sort((left, right) => {
      if (left.prefixRank !== right.prefixRank) {
        return left.prefixRank - right.prefixRank;
      }

      if (left.fuzzyScore !== right.fuzzyScore) {
        return right.fuzzyScore - left.fuzzyScore;
      }

      if (left.recencyScore !== right.recencyScore) {
        return right.recencyScore - left.recencyScore;
      }

      return left.symbol.symbolName.localeCompare(right.symbol.symbolName);
    });

    return ranked.slice(0, 200).map((entry) => {
      const symbol = entry.symbol;
      const modulePrefix = mode === 'C' ? this.resolveModulePrefix(symbol.filePath) : undefined;
      const symbolLabel = modulePrefix ? `${modulePrefix}: ${symbol.symbolName}` : symbol.symbolName;
      return new vscode.SymbolInformation(
        symbolLabel,
        toSymbolKind(symbol.symbolKind),
        symbol.containerName ?? '',
        new vscode.Location(vscode.Uri.file(symbol.filePath), new vscode.Position(Math.max(0, symbol.lineNumber - 1), 0))
      );
    });
  }

  private resolveModulePrefix(filePath: string): string {
    const relative = vscode.workspace.asRelativePath(filePath, false);
    const normalized = relative.replace(/^[^/]+\//, '');
    const firstSegment = normalized.split('/')[0];
    if (firstSegment && firstSegment.length > 0) {
      return firstSegment;
    }

    const directoryName = path.basename(path.dirname(filePath));
    return directoryName || 'module';
  }
}
