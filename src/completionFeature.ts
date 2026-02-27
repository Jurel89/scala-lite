import * as vscode from 'vscode';
import { SymbolIndexManager } from './symbolIndex';
import { WorkspaceMode } from './modePresentation';
import { StructuredLogger } from './structuredLogger';

const COMPLETION_RESULT_LIMIT = 50;
const COMPLETION_TRIGGER_MIN_LENGTH = 2;

type SymbolKind = 'package' | 'object' | 'class' | 'trait' | 'def' | 'val' | 'type' | 'param';

function mapSymbolKindToCompletionKind(kind: SymbolKind): vscode.CompletionItemKind {
  switch (kind) {
    case 'class': return vscode.CompletionItemKind.Class;
    case 'trait': return vscode.CompletionItemKind.Interface;
    case 'object': return vscode.CompletionItemKind.Module;
    case 'def': return vscode.CompletionItemKind.Method;
    case 'val': return vscode.CompletionItemKind.Variable;
    case 'type': return vscode.CompletionItemKind.TypeParameter;
    case 'package': return vscode.CompletionItemKind.Module;
    case 'param': return vscode.CompletionItemKind.Variable;
  }
}

export class ScalaCompletionProvider implements vscode.CompletionItemProvider {
  private readonly symbolIndexManager: SymbolIndexManager;
  private readonly getMode: () => WorkspaceMode;
  private readonly logger: StructuredLogger;

  public constructor(
    symbolIndexManager: SymbolIndexManager,
    getMode: () => WorkspaceMode,
    logger: StructuredLogger
  ) {
    this.symbolIndexManager = symbolIndexManager;
    this.getMode = getMode;
    this.logger = logger;
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.CompletionItem[]> {
    if (this.getMode() !== 'C') {
      return [];
    }

    if (token.isCancellationRequested) {
      return [];
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return [];
    }

    const prefix = document.getText(wordRange);
    if (prefix.length < COMPLETION_TRIGGER_MIN_LENGTH) {
      return [];
    }

    const startedAt = Date.now();

    try {
      const symbols = await this.symbolIndexManager.searchSymbols(prefix, COMPLETION_RESULT_LIMIT, token);

      if (token.isCancellationRequested) {
        return [];
      }

      const seen = new Set<string>();
      const items: vscode.CompletionItem[] = [];

      for (const symbol of symbols) {
        if (symbol.symbolKind === 'package') {
          continue;
        }

        const dedupeKey = `${symbol.symbolName}:${symbol.symbolKind}`;
        if (seen.has(dedupeKey)) {
          continue;
        }
        seen.add(dedupeKey);

        const item = new vscode.CompletionItem(
          symbol.symbolName,
          mapSymbolKindToCompletionKind(symbol.symbolKind as SymbolKind)
        );

        item.detail = symbol.packageName
          ? `${symbol.packageName}.${symbol.symbolName}`
          : symbol.symbolName;

        item.sortText = symbol.symbolName.startsWith(prefix)
          ? `0${symbol.symbolName}`
          : `1${symbol.symbolName}`;

        items.push(item);
      }

      this.logger.debug('SEARCH', `Completion: ${items.length} item(s) for "${prefix}"`, Date.now() - startedAt);
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('SEARCH', `Completion error: ${message}`, Date.now() - startedAt);
      return [];
    }
  }
}
