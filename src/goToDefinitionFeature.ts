import * as vscode from 'vscode';
import { Minimatch } from 'minimatch';
import { WorkspaceMode } from './modePresentation';
import { SymbolIndexManager } from './symbolIndex';
import { resolveWorkspaceIgnoreRules } from './ignoreRules';
import { readBudgetConfigFromWorkspaceConfig } from './workspaceConfig';
import { StructuredLogger } from './structuredLogger';

function parsePackageName(document: vscode.TextDocument): string {
  for (let index = 0; index < Math.min(document.lineCount, 80); index += 1) {
    const match = document.lineAt(index).text.match(/^\s*package\s+([A-Za-z0-9_.]+)/);
    if (match) {
      return match[1];
    }
  }

  return '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDefinitionPattern(symbolName: string): RegExp {
  return new RegExp(`\\b(def|val|var|class|object|trait|type|enum|given)\\s+${escapeRegExp(symbolName)}\\b`);
}

function toLocation(filePath: string, lineNumber: number): vscode.Location {
  return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(Math.max(0, lineNumber - 1), 0));
}

export class GoToDefinitionProvider implements vscode.DefinitionProvider {
  private readonly symbolIndexManager: SymbolIndexManager;
  private readonly getMode: () => WorkspaceMode;
  private readonly logger: StructuredLogger;
  private activeBadge: vscode.Disposable | undefined;

  public constructor(symbolIndexManager: SymbolIndexManager, getMode: () => WorkspaceMode, logger: StructuredLogger) {
    this.symbolIndexManager = symbolIndexManager;
    this.getMode = getMode;
    this.logger = logger;
  }

  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Definition> {
    this.clearBadge();

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return [];
    }

    const symbolName = document.getText(wordRange);
    if (!symbolName || token.isCancellationRequested) {
      return [];
    }

    const tier1 = this.findSameFileDefinition(document, symbolName, position.line);
    if (tier1) {
      return tier1;
    }

    const mode = this.getMode();
    if (mode === 'A') {
      return [];
    }

    const tier2 = this.findIndexedDefinition(document, symbolName);
    if (tier2) {
      this.showBadge(vscode.l10n.t('📍 Likely match'));
      return tier2;
    }

    const tier3 = await this.findTextSearchDefinition(document, symbolName, token);
    if (tier3) {
      this.showBadge(vscode.l10n.t('🔍 Text search'));
      return tier3;
    }

    const action = await vscode.window.showInformationMessage(
      vscode.l10n.t('No definition found for {0}. Try Find in Files.', symbolName),
      vscode.l10n.t('Open Find in Files')
    );

    if (action === vscode.l10n.t('Open Find in Files')) {
      await vscode.commands.executeCommand('workbench.action.findInFiles', { query: symbolName });
    }
    this.logger.info('SEARCH', `No definition found for symbol: ${symbolName}`);

    return [];
  }

  private findSameFileDefinition(
    document: vscode.TextDocument,
    symbolName: string,
    currentLine: number
  ): vscode.Location | undefined {
    const symbols = this.symbolIndexManager.getSymbolsForFile(document.uri);
    const sameFile = symbols.find((symbol) => symbol.symbolName === symbolName && symbol.lineNumber - 1 !== currentLine);
    if (!sameFile) {
      return undefined;
    }

    return toLocation(sameFile.filePath, sameFile.lineNumber);
  }

  private findIndexedDefinition(document: vscode.TextDocument, symbolName: string): vscode.Location | undefined {
    const currentPackage = parsePackageName(document);
    const candidates = this.symbolIndexManager
      .getAllSymbols()
      .filter((symbol) => symbol.symbolName === symbolName);

    if (candidates.length === 0) {
      return undefined;
    }

    candidates.sort((left, right) => {
      const leftPackageBoost = left.containerName === currentPackage ? 0 : 1;
      const rightPackageBoost = right.containerName === currentPackage ? 0 : 1;
      if (leftPackageBoost !== rightPackageBoost) {
        return leftPackageBoost - rightPackageBoost;
      }

      return left.filePath.localeCompare(right.filePath);
    });

    return toLocation(candidates[0].filePath, candidates[0].lineNumber);
  }

  private async findTextSearchDefinition(
    document: vscode.TextDocument,
    symbolName: string,
    token: vscode.CancellationToken
  ): Promise<vscode.Location | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined;
    }

    const ignoreRules = await resolveWorkspaceIgnoreRules();
    const ignoreMatchers = ignoreRules.effectivePatterns.map((pattern) => new Minimatch(pattern, { dot: true }));
    const budget = await readBudgetConfigFromWorkspaceConfig();
    const startedAt = Date.now();
    const pattern = buildDefinitionPattern(symbolName);

    const fileUris = await vscode.workspace.findFiles('**/*.{scala,sbt}', undefined, 5000);
    const matches: Array<{ readonly uri: vscode.Uri; readonly line: number; readonly packageName: string; readonly preview: string }> = [];

    for (const fileUri of fileUris) {
      if (token.isCancellationRequested) {
        return undefined;
      }

      if (Date.now() - startedAt >= budget.searchTimeMs) {
        break;
      }

      const relativePath = vscode.workspace.asRelativePath(fileUri, false).replace(/^[^/]+\//, '');
      if (ignoreMatchers.some((matcher) => matcher.match(relativePath) || matcher.match(`${relativePath}/`))) {
        continue;
      }

      try {
        const textDocument = await vscode.workspace.openTextDocument(fileUri);
        const packageName = parsePackageName(textDocument);

        for (let line = 0; line < textDocument.lineCount; line += 1) {
          const text = textDocument.lineAt(line).text;
          if (!pattern.test(text)) {
            continue;
          }

          matches.push({
            uri: fileUri,
            line,
            packageName,
            preview: text.trim()
          });

          if (matches.length >= 50) {
            break;
          }
        }
      } catch {
      }

      if (matches.length >= 50) {
        break;
      }
    }

    if (matches.length === 0) {
      return undefined;
    }

    if (matches.length === 1) {
      return new vscode.Location(matches[0].uri, new vscode.Position(matches[0].line, 0));
    }

    const currentPackage = parsePackageName(document);
    matches.sort((left, right) => {
      const leftPackageBoost = left.packageName === currentPackage ? 0 : 1;
      const rightPackageBoost = right.packageName === currentPackage ? 0 : 1;
      if (leftPackageBoost !== rightPackageBoost) {
        return leftPackageBoost - rightPackageBoost;
      }

      return left.uri.fsPath.localeCompare(right.uri.fsPath);
    });

    const picked = await vscode.window.showQuickPick(
      matches.map((entry) => ({
        label: `${vscode.workspace.asRelativePath(entry.uri, false)}:${entry.line + 1}`,
        description: entry.packageName,
        detail: entry.preview,
        entry
      })),
      {
        title: vscode.l10n.t('Select definition for {0}', symbolName)
      }
    );

    if (!picked) {
      return undefined;
    }

    return new vscode.Location(picked.entry.uri, new vscode.Position(picked.entry.line, 0));
  }

  private showBadge(message: string): void {
    this.clearBadge();
    this.activeBadge = vscode.window.setStatusBarMessage(message, 5000);
  }

  private clearBadge(): void {
    if (this.activeBadge) {
      this.activeBadge.dispose();
      this.activeBadge = undefined;
    }
  }
}
