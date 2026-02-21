import * as vscode from 'vscode';
import * as path from 'node:path';
import { Minimatch } from 'minimatch';
import { WorkspaceMode } from './modePresentation';
import { SymbolIndexManager } from './symbolIndex';
import { resolveWorkspaceIgnoreRules } from './ignoreRules';
import {
  readBudgetConfigFromWorkspaceConfig,
  readModuleFolderFromWorkspaceConfig
} from './workspaceConfig';

type SearchScope = 'current-file' | 'current-folder' | 'current-module' | 'entire-workspace';

interface ScopePickItem extends vscode.QuickPickItem {
  readonly scope: SearchScope;
}

const MAX_FILE_SIZE_BYTES = 1_000_000;
const COMMON_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.pdf', '.zip', '.gz', '.jar', '.class', '.so', '.dylib'
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getDefaultScope(mode: WorkspaceMode): SearchScope {
  if (mode === 'A') {
    return 'current-file';
  }

  if (mode === 'B') {
    return 'current-folder';
  }

  return 'current-module';
}

function scopeLabel(scope: SearchScope): string {
  if (scope === 'current-file') {
    return 'Current File';
  }

  if (scope === 'current-folder') {
    return 'Current Folder';
  }

  if (scope === 'current-module') {
    return 'Current Module';
  }

  return 'Entire Workspace';
}

async function pickScope(defaultScope: SearchScope, mode: WorkspaceMode): Promise<SearchScope | undefined> {
  const options: ScopePickItem[] = [];
  const scopeCandidates: readonly SearchScope[] = [
    defaultScope,
    'current-file',
    'current-folder',
    'current-module',
    'entire-workspace'
  ];

  const orderedScopes: SearchScope[] = scopeCandidates
    .filter((scope, index, all) => all.indexOf(scope) === index)
    .filter((scope) => mode === 'C' || scope !== 'current-module');

  for (const scope of orderedScopes) {
    options.push({
      label: vscode.l10n.t(scopeLabel(scope)),
      description: scope === defaultScope ? vscode.l10n.t('Default') : undefined,
      picked: scope === defaultScope,
      scope
    });
  }

  const picked = await vscode.window.showQuickPick(options, {
    title: vscode.l10n.t('Find Usages Scope')
  });

  return picked?.scope;
}

async function confirmWorkspaceScope(): Promise<'search' | 'narrow' | 'cancel'> {
  const selection = await vscode.window.showWarningMessage(
    vscode.l10n.t('Searching all workspace files may be slow for large repos. Continue?'),
    vscode.l10n.t('Search'),
    vscode.l10n.t('Narrow Scope'),
    vscode.l10n.t('Cancel')
  );

  if (selection === vscode.l10n.t('Search')) {
    return 'search';
  }

  if (selection === vscode.l10n.t('Narrow Scope')) {
    return 'narrow';
  }

  return 'cancel';
}

function shouldSkipByExtension(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.class' || COMMON_BINARY_EXTENSIONS.has(extension);
}

async function shouldSkipFile(fileUri: vscode.Uri): Promise<boolean> {
  if (shouldSkipByExtension(fileUri.fsPath)) {
    return true;
  }

  try {
    const stat = await vscode.workspace.fs.stat(fileUri);
    return stat.size > MAX_FILE_SIZE_BYTES;
  } catch {
    return true;
  }
}

async function resolveCandidateFiles(document: vscode.TextDocument, scope: SearchScope): Promise<readonly vscode.Uri[]> {
  if (scope === 'current-file') {
    return [document.uri];
  }

  if (scope === 'current-folder') {
    const folderUri = vscode.Uri.file(path.dirname(document.uri.fsPath));
    return vscode.workspace.findFiles(new vscode.RelativePattern(folderUri, '**/*.{scala,sbt}'), undefined, 5000);
  }

  if (scope === 'current-module') {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return [];
    }

    const moduleRelativePath = await readModuleFolderFromWorkspaceConfig();
    const moduleUri = moduleRelativePath
      ? vscode.Uri.joinPath(workspaceFolder.uri, moduleRelativePath)
      : workspaceFolder.uri;

    return vscode.workspace.findFiles(new vscode.RelativePattern(moduleUri, '**/*.{scala,sbt}'), undefined, 5000);
  }

  return vscode.workspace.findFiles('**/*.{scala,sbt}', undefined, 5000);
}

export class FindUsagesProvider implements vscode.ReferenceProvider {
  private readonly symbolIndexManager: SymbolIndexManager;
  private readonly getMode: () => WorkspaceMode;

  public constructor(symbolIndexManager: SymbolIndexManager, getMode: () => WorkspaceMode) {
    this.symbolIndexManager = symbolIndexManager;
    this.getMode = getMode;
  }

  public async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken
  ): Promise<vscode.Location[]> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange || token.isCancellationRequested) {
      return [];
    }

    const symbol = document.getText(wordRange).trim();
    if (!symbol) {
      return [];
    }

    const mode = this.getMode();
    const defaultScope = getDefaultScope(mode);

    let selectedScope = await pickScope(defaultScope, mode);
    if (!selectedScope) {
      return [];
    }

    while (selectedScope === 'entire-workspace') {
      const decision = await confirmWorkspaceScope();
      if (decision === 'search') {
        break;
      }

      if (decision === 'cancel') {
        return [];
      }

      selectedScope = await pickScope(defaultScope, mode);
      if (!selectedScope) {
        return [];
      }
    }

    // Primary message with symbol and scope context (FR-0022)
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('Textual references for {0} (scope: {1})', symbol, scopeLabel(selectedScope)),
      3500
    );

    const budget = await readBudgetConfigFromWorkspaceConfig();
    const initialSearch = await this.searchReferences(document, symbol, selectedScope, budget.searchTimeMs, token);

    if (!initialSearch.truncated) {
      return initialSearch.results;
    }

    const action = await vscode.window.showInformationMessage(
      vscode.l10n.t('Search stopped at budget limit. Found {0} references.', String(initialSearch.results.length)),
      vscode.l10n.t('Show All — may take longer')
    );

    if (action !== vscode.l10n.t('Show All — may take longer')) {
      return initialSearch.results;
    }

    const extendedSearch = await this.searchReferences(document, symbol, selectedScope, undefined, token);
    return extendedSearch.results;
  }

  private async searchReferences(
    document: vscode.TextDocument,
    symbol: string,
    scope: SearchScope,
    budgetMs: number | undefined,
    token: vscode.CancellationToken
  ): Promise<{ readonly results: vscode.Location[]; readonly truncated: boolean }> {
    const startedAt = Date.now();
    const ignoreRules = await resolveWorkspaceIgnoreRules();
    const ignoreMatchers = ignoreRules.effectivePatterns.map((pattern) => new Minimatch(pattern, { dot: true }));
    const fileUris = await resolveCandidateFiles(document, scope);
    const prioritizedFileUris = await this.prioritizeCandidateFiles(fileUris, symbol, token);
    const regex = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const locations: vscode.Location[] = [];
    let truncated = false;

    for (const fileUri of prioritizedFileUris) {
      if (token.isCancellationRequested) {
        return { results: locations, truncated: false };
      }

      if (budgetMs !== undefined && Date.now() - startedAt >= budgetMs) {
        truncated = true;
        break;
      }

      const relativePath = vscode.workspace.asRelativePath(fileUri, false).replace(/^[^/]+\//, '');
      if (ignoreMatchers.some((matcher) => matcher.match(relativePath) || matcher.match(`${relativePath}/`))) {
        continue;
      }

      if (await shouldSkipFile(fileUri)) {
        continue;
      }

      let textDocument: vscode.TextDocument;
      try {
        textDocument = await vscode.workspace.openTextDocument(fileUri);
      } catch {
        continue;
      }

      for (let lineIndex = 0; lineIndex < textDocument.lineCount; lineIndex += 1) {
        if (token.isCancellationRequested) {
          return { results: locations, truncated: false };
        }

        if (budgetMs !== undefined && Date.now() - startedAt >= budgetMs) {
          truncated = true;
          break;
        }

        const lineText = textDocument.lineAt(lineIndex).text;
        regex.lastIndex = 0;
        if (!regex.test(lineText)) {
          continue;
        }

        const matchIndex = lineText.search(regex);
        locations.push(
          new vscode.Location(
            fileUri,
            new vscode.Range(
              new vscode.Position(lineIndex, Math.max(0, matchIndex)),
              new vscode.Position(lineIndex, Math.max(0, matchIndex) + symbol.length)
            )
          )
        );
      }

      if (truncated) {
        break;
      }
    }

    return { results: locations, truncated };
  }

  private async prioritizeCandidateFiles(
    candidateFiles: readonly vscode.Uri[],
    symbol: string,
    token: vscode.CancellationToken
  ): Promise<readonly vscode.Uri[]> {
    if (candidateFiles.length <= 1 || token.isCancellationRequested) {
      return candidateFiles;
    }

    const nativeMatches = await this.symbolIndexManager.searchSymbols(symbol, 400, token);
    const prioritizedPathSet = new Set(
      nativeMatches
        .filter((match) => match.symbolName === symbol)
        .map((match) => path.resolve(match.filePath))
    );

    if (prioritizedPathSet.size === 0) {
      return candidateFiles;
    }

    const prioritized: vscode.Uri[] = [];
    const remaining: vscode.Uri[] = [];

    for (const fileUri of candidateFiles) {
      if (prioritizedPathSet.has(path.resolve(fileUri.fsPath))) {
        prioritized.push(fileUri);
        continue;
      }

      remaining.push(fileUri);
    }

    if (prioritized.length === 0) {
      return candidateFiles;
    }

    return [...prioritized, ...remaining];
  }
}
