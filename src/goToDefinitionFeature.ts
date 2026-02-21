import * as vscode from 'vscode';
import * as path from 'node:path';
import { Minimatch } from 'minimatch';
import { WorkspaceMode } from './modePresentation';
import { IndexedSymbol, SymbolIndexManager } from './symbolIndex';
import { resolveWorkspaceIgnoreRules } from './ignoreRules';
import { readBudgetConfigFromWorkspaceConfig } from './workspaceConfig';
import { StructuredLogger } from './structuredLogger';
import { formatResultBadge } from './resultBadges';
import { compareSymbols, compareSymbolsWithCursorProximity } from './symbolSort';

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

function leadingWhitespace(text: string): string {
  const match = text.match(/^\s*/);
  return match?.[0] ?? '';
}

function indentationWidth(text: string): number {
  const whitespace = leadingWhitespace(text);
  let width = 0;
  for (const ch of whitespace) {
    width += ch === '\t' ? 2 : 1;
  }

  return width;
}

function detectIndentationStyle(text: string): 'spaces' | 'tabs' | 'mixed' | 'none' {
  const whitespace = leadingWhitespace(text);
  if (!whitespace) {
    return 'none';
  }

  const hasSpace = whitespace.includes(' ');
  const hasTab = whitespace.includes('\t');

  if (hasSpace && hasTab) {
    return 'mixed';
  }

  return hasTab ? 'tabs' : 'spaces';
}

type StageConfidence = 'high' | 'medium' | 'low';

interface ResolutionOriginSnapshot {
  readonly originDocumentUri: vscode.Uri;
  readonly originFilePath: string;
  readonly originPackageName: string;
  readonly originLine: number;
  readonly originColumn: number;
  readonly tokenText: string;
}

interface StageResolutionResult {
  readonly stage: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  readonly confidence: StageConfidence;
  readonly candidates: readonly IndexedSymbol[];
}

interface DefinitionResolution {
  readonly location: vscode.Location;
  readonly confidence: StageConfidence;
  readonly source: 'indexed' | 'text';
}

export type SharedDefinitionResolution =
  | {
      readonly kind: 'single';
      readonly symbolName: string;
      readonly symbol: IndexedSymbol;
      readonly location: vscode.Location;
      readonly confidence: StageConfidence;
      readonly source: 'indexed' | 'text';
      readonly stage: StageResolutionResult['stage'];
      readonly reason: string;
    }
  | {
      readonly kind: 'multiple';
      readonly symbolName: string;
      readonly candidates: readonly IndexedSymbol[];
      readonly confidence: StageConfidence;
      readonly stage: StageResolutionResult['stage'];
      readonly reason: string;
    }
  | {
      readonly kind: 'none';
      readonly symbolName: string;
      readonly reason: string;
    };

interface StickyChoiceEntry {
  readonly targetFilePath: string;
  readonly targetLineNumber: number;
  readonly symbolName: string;
}

const STICKY_CACHE_LIMIT = 200;

function stageReasonBadge(stage: StageResolutionResult['stage']): string {
  if (stage === 'A') {
    return 'local';
  }
  if (stage === 'C') {
    return 'imported';
  }
  if (stage === 'D') {
    return 'same package';
  }
  if (stage === 'E') {
    return 'module index';
  }
  if (stage === 'F') {
    return 'text match';
  }

  return 'same file';
}

function symbolKindCodicon(kind: IndexedSymbol['symbolKind']): string {
  if (kind === 'class') {
    return '$(symbol-class)';
  }
  if (kind === 'trait') {
    return '$(symbol-interface)';
  }
  if (kind === 'object') {
    return '$(symbol-object)';
  }
  if (kind === 'package') {
    return '$(package)';
  }
  if (kind === 'type') {
    return '$(symbol-type-parameter)';
  }
  if (kind === 'val') {
    return '$(symbol-variable)';
  }
  if (kind === 'param') {
    return '$(symbol-parameter)';
  }

  return '$(symbol-method)';
}

export class GoToDefinitionProvider implements vscode.DefinitionProvider {
  private readonly symbolIndexManager: SymbolIndexManager;
  private readonly getMode: () => WorkspaceMode;
  private readonly logger: StructuredLogger;
  private activeBadge: vscode.Disposable | undefined;
  private readonly stickyChoiceCache = new Map<string, StickyChoiceEntry>();

  public constructor(symbolIndexManager: SymbolIndexManager, getMode: () => WorkspaceMode, logger: StructuredLogger) {
    this.symbolIndexManager = symbolIndexManager;
    this.getMode = getMode;
    this.logger = logger;

    vscode.workspace.onDidSaveTextDocument((document) => {
      this.invalidateStickyEntriesForTargetFile(document.uri.fsPath);
    });
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

    this.logger.debug('SEARCH', `Definition lookup requested for '${symbolName}' in mode ${this.getMode()}.`);
    const originSnapshot = this.captureOriginSnapshot(document, position, symbolName);
    const resolved = await this.resolveWithStagedPipeline(document, originSnapshot, token);
    if (resolved) {
      if (resolved.source === 'text') {
        this.showBadge(vscode.l10n.t('🔍 Text Search'));
        vscode.window.setStatusBarMessage(`${formatResultBadge('text')} ${vscode.l10n.t('Text Search')}`, 3000);
      } else if (resolved.confidence === 'high') {
        this.showBadge(vscode.l10n.t('Exact'));
        vscode.window.setStatusBarMessage(`${formatResultBadge('indexed')} ${vscode.l10n.t('Exact')}`, 3000);
      } else {
        this.showBadge(vscode.l10n.t('📍 Likely'));
        vscode.window.setStatusBarMessage(`${formatResultBadge('indexed')} ${vscode.l10n.t('Indexed')}`, 3000);
      }

      return resolved.location;
    }

    vscode.window.setStatusBarMessage(vscode.l10n.t('No definition found for {0}.', symbolName), 2500);
    this.logger.info('SEARCH', `No definition found for symbol: ${symbolName}`);

    return [];
  }

  public async resolveDefinitionCandidates(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    options?: {
      readonly includeSticky?: boolean;
      readonly includeTextSearch?: boolean;
      readonly hoverLocalFirstGuard?: boolean;
    }
  ): Promise<SharedDefinitionResolution> {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return {
        kind: 'none',
        symbolName: '',
        reason: 'no-token'
      };
    }

    const symbolName = document.getText(wordRange);
    if (!symbolName || token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName,
        reason: token.isCancellationRequested ? 'cancelled' : 'empty-token'
      };
    }

    this.traceTokenExtraction(document, position, wordRange, symbolName);

    const originSnapshot = this.captureOriginSnapshot(document, position, symbolName);
    return this.resolveStagedCandidatesFromOrigin(document, originSnapshot, token, {
      includeSticky: options?.includeSticky ?? true,
      includeTextSearch: options?.includeTextSearch ?? true,
      hoverLocalFirstGuard: options?.hoverLocalFirstGuard ?? false
    });
  }

  private captureOriginSnapshot(document: vscode.TextDocument, position: vscode.Position, tokenText: string): ResolutionOriginSnapshot {
    return {
      originDocumentUri: document.uri,
      originFilePath: document.uri.fsPath,
      originPackageName: parsePackageName(document),
      originLine: position.line,
      originColumn: position.character,
      tokenText
    };
  }

  private async resolveWithStagedPipeline(
    document: vscode.TextDocument,
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken
  ): Promise<DefinitionResolution | undefined> {
    const staged = await this.resolveStagedCandidatesFromOrigin(document, originSnapshot, token, {
      includeSticky: true,
      includeTextSearch: true,
      hoverLocalFirstGuard: false
    });

    if (staged.kind === 'single') {
      return {
        location: staged.location,
        confidence: staged.confidence,
        source: staged.source
      };
    }

    if (staged.kind === 'multiple') {
      const picked = await this.showIndexedCandidateChooser(originSnapshot, staged.candidates, staged.stage);
      if (!picked) {
        return undefined;
      }

      return {
        location: toLocation(picked.filePath, picked.lineNumber),
        confidence: 'medium',
        source: 'indexed'
      };
    }

    return undefined;
  }

  private async resolveStagedCandidatesFromOrigin(
    document: vscode.TextDocument,
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken,
    options: {
      readonly includeSticky: boolean;
      readonly includeTextSearch: boolean;
      readonly hoverLocalFirstGuard: boolean;
    }
  ): Promise<SharedDefinitionResolution> {
    const mode = this.getMode();

    if (token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'cancelled'
      };
    }

    if (options.includeSticky) {
      const stickyHit = await this.resolveFromStickyCache(originSnapshot, token);
      if (stickyHit) {
        return {
          kind: 'single',
          symbolName: originSnapshot.tokenText,
          symbol: {
            symbolName: originSnapshot.tokenText,
            symbolKind: 'def',
            filePath: stickyHit.location.uri.fsPath,
            lineNumber: stickyHit.location.range.start.line + 1,
            packageName: originSnapshot.originPackageName,
            visibility: 'unknown'
          },
          location: stickyHit.location,
          confidence: stickyHit.confidence,
          source: stickyHit.source,
          stage: 'A',
          reason: 'sticky-cache'
        };
      }
    }

    const stageA = this.resolveStageALocalLexical(document, originSnapshot);
    this.traceStage(stageA, originSnapshot);
    if (stageA.candidates.length === 1 && stageA.confidence === 'high') {
      return this.toSingleResolution(originSnapshot, stageA.candidates[0], 'high', 'indexed', stageA.stage, 'stage-A');
    }

    if (token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'cancelled'
      };
    }

    const stageB = this.resolveStageBSameFileTopLevel(document, originSnapshot);
    this.traceStage(stageB, originSnapshot);
    if (stageB.candidates.length === 1 && stageB.confidence === 'high') {
      return this.toSingleResolution(originSnapshot, stageB.candidates[0], 'high', 'indexed', stageB.stage, 'stage-B');
    }

    if (
      options.hoverLocalFirstGuard
      && this.hasLocalIdentifierContext(document, originSnapshot.tokenText, originSnapshot.originLine)
    ) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'local-context-unresolved'
      };
    }

    if (mode === 'A' || token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: mode === 'A' ? 'mode-a-disabled' : 'cancelled'
      };
    }

    const stageC = await this.resolveStageCImportAware(originSnapshot, token);
    this.traceStage(stageC, originSnapshot);
    if (stageC.candidates.length === 1 && stageC.confidence === 'high') {
      return this.toSingleResolution(originSnapshot, stageC.candidates[0], 'high', 'indexed', stageC.stage, 'stage-C');
    }

    if (stageC.candidates.length > 1) {
      return {
        kind: 'multiple',
        symbolName: originSnapshot.tokenText,
        candidates: stageC.candidates,
        confidence: stageC.confidence,
        stage: stageC.stage,
        reason: 'stage-C-ambiguous'
      };
    }

    if (token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'cancelled'
      };
    }

    const stageD = await this.resolveStageDSamePackage(originSnapshot, token);
    this.traceStage(stageD, originSnapshot);
    if (stageD.candidates.length === 1 && stageD.confidence === 'high') {
      return this.toSingleResolution(originSnapshot, stageD.candidates[0], 'high', 'indexed', stageD.stage, 'stage-D');
    }

    if (stageD.candidates.length > 1) {
      return {
        kind: 'multiple',
        symbolName: originSnapshot.tokenText,
        candidates: stageD.candidates,
        confidence: stageD.confidence,
        stage: stageD.stage,
        reason: 'stage-D-ambiguous'
      };
    }

    if (token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'cancelled'
      };
    }

    const stageE = await this.resolveStageEModuleIndex(originSnapshot, token);
    this.traceStage(stageE, originSnapshot);
    if (stageE.candidates.length === 1 && stageE.confidence === 'high') {
      return this.toSingleResolution(originSnapshot, stageE.candidates[0], 'high', 'indexed', stageE.stage, 'stage-E');
    }

    if (stageE.candidates.length > 1) {
      return {
        kind: 'multiple',
        symbolName: originSnapshot.tokenText,
        candidates: stageE.candidates,
        confidence: stageE.confidence,
        stage: stageE.stage,
        reason: 'stage-E-ambiguous'
      };
    }

    if (token.isCancellationRequested) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'cancelled'
      };
    }

    if (!options.includeTextSearch) {
      return {
        kind: 'none',
        symbolName: originSnapshot.tokenText,
        reason: 'insufficient-confidence'
      };
    }

    const stageF = await this.resolveStageFTextSearch(document, originSnapshot, token);
    this.traceStage(stageF, originSnapshot);
    if (stageF.candidates.length > 0) {
      return {
        kind: 'multiple',
        symbolName: originSnapshot.tokenText,
        candidates: stageF.candidates,
        confidence: stageF.confidence,
        stage: stageF.stage,
        reason: 'stage-F-text'
      };
    }

    return {
      kind: 'none',
      symbolName: originSnapshot.tokenText,
      reason: 'no-matches'
    };
  }

  private toSingleResolution(
    originSnapshot: ResolutionOriginSnapshot,
    symbol: IndexedSymbol,
    confidence: StageConfidence,
    source: 'indexed' | 'text',
    stage: StageResolutionResult['stage'],
    reason: string
  ): SharedDefinitionResolution {
    return {
      kind: 'single',
      symbolName: originSnapshot.tokenText,
      symbol,
      location: toLocation(symbol.filePath, symbol.lineNumber),
      confidence,
      source,
      stage,
      reason
    };
  }

  private resolveStageALocalLexical(
    document: vscode.TextDocument,
    originSnapshot: ResolutionOriginSnapshot
  ): StageResolutionResult {
    const parameterDefinition = this.findParameterDefinitionInScope(document, originSnapshot.tokenText, originSnapshot.originLine);
    if (parameterDefinition) {
      return {
        stage: 'A',
        confidence: 'high',
        candidates: [{
          symbolName: originSnapshot.tokenText,
          symbolKind: 'param',
          filePath: parameterDefinition.uri.fsPath,
          lineNumber: parameterDefinition.range.start.line + 1,
          packageName: originSnapshot.originPackageName,
          visibility: 'unknown'
        }]
      };
    }

    const sameFile = this.findSameFileDefinition(document, originSnapshot.tokenText, originSnapshot.originLine);
    if (!sameFile) {
      return {
        stage: 'A',
        confidence: 'low',
        candidates: []
      };
    }

    return {
      stage: 'A',
      confidence: 'high',
      candidates: [{
        symbolName: originSnapshot.tokenText,
        symbolKind: 'def',
        filePath: sameFile.uri.fsPath,
        lineNumber: sameFile.range.start.line + 1,
        packageName: originSnapshot.originPackageName,
        visibility: 'unknown'
      }]
    };
  }

  private findParameterDefinitionInScope(
    document: vscode.TextDocument,
    symbolName: string,
    currentLine: number
  ): vscode.Location | undefined {
    const maxLookBack = 400;
    const minLine = Math.max(0, currentLine - maxLookBack);
    let searchLine = currentLine;

    while (searchLine >= minLine) {
      const signatureRange = this.findNearestEnclosingDefSignatureFromLine(document, searchLine, minLine);
      if (!signatureRange) {
        break;
      }

      const signatureEndLine = signatureRange.lines.length > 0
        ? signatureRange.lines[signatureRange.lines.length - 1].line
        : signatureRange.startLine;
      if (!this.isCursorWithinDefinitionScope(document, signatureRange.startLine, signatureEndLine, currentLine)) {
        searchLine = signatureRange.startLine - 1;
        continue;
      }

      const signatureText = signatureRange.lines.map((entry) => entry.text).join('\n');
      const parameterNames = this.extractParameterNames(signatureText);
      if (parameterNames.includes(symbolName)) {
        const declarationLocation = this.findNameInSignatureLines(signatureRange.lines, symbolName);
        if (declarationLocation) {
          return new vscode.Location(document.uri, declarationLocation);
        }
      }

      searchLine = signatureRange.startLine - 1;
    }

    return undefined;
  }

  private isCursorWithinDefinitionScope(
    document: vscode.TextDocument,
    signatureStartLine: number,
    signatureEndLine: number,
    cursorLine: number
  ): boolean {
    if (cursorLine < signatureStartLine) {
      return false;
    }

    if (cursorLine <= signatureEndLine) {
      return true;
    }

    const bodyOpen = this.findDefinitionBodyOpen(document, signatureStartLine, signatureEndLine);
    if (!bodyOpen) {
      const nextDefLine = this.findNextDefSignatureLine(document, signatureEndLine + 1);
      if (nextDefLine === undefined) {
        return true;
      }

      return cursorLine < nextDefLine;
    }

    let depth = 0;
    for (let line = bodyOpen.line; line <= cursorLine && line < document.lineCount; line += 1) {
      const text = document.lineAt(line).text;
      const startCharacter = line === bodyOpen.line ? bodyOpen.character : 0;
      for (let index = startCharacter; index < text.length; index += 1) {
        const ch = text[index];
        if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
        }
      }

      if (line < cursorLine && depth <= 0) {
        return false;
      }
    }

    return depth > 0;
  }

  private findDefinitionBodyOpen(
    document: vscode.TextDocument,
    signatureStartLine: number,
    signatureEndLine: number
  ): { readonly line: number; readonly character: number } | undefined {
    const scanEnd = Math.min(document.lineCount - 1, signatureEndLine + 20);
    for (let line = signatureStartLine; line <= scanEnd; line += 1) {
      const text = document.lineAt(line).text;
      const openBrace = text.indexOf('{');
      if (openBrace >= 0) {
        return {
          line,
          character: openBrace
        };
      }
    }

    return undefined;
  }

  private findNextDefSignatureLine(document: vscode.TextDocument, startLine: number): number | undefined {
    for (let line = Math.max(0, startLine); line < Math.min(document.lineCount, startLine + 300); line += 1) {
      const text = document.lineAt(line).text;
      if (/^\s*(?:final\s+|override\s+|private\s+|protected\s+)*def\s+[A-Za-z_][A-Za-z0-9_]*/.test(text)) {
        return line;
      }
    }

    return undefined;
  }

  private findNearestEnclosingDefSignature(
    document: vscode.TextDocument,
    currentLine: number
  ): { readonly lines: ReadonlyArray<{ readonly line: number; readonly text: string }> } | undefined {
    const maxLookBack = 120;
    const minLine = Math.max(0, currentLine - maxLookBack);
    const result = this.findNearestEnclosingDefSignatureFromLine(document, currentLine, minLine);
    if (!result) {
      return undefined;
    }

    return {
      lines: result.lines
    };
  }

  private findNearestEnclosingDefSignatureFromLine(
    document: vscode.TextDocument,
    searchFromLine: number,
    minLine: number
  ): {
    readonly startLine: number;
    readonly lines: ReadonlyArray<{ readonly line: number; readonly text: string }>;
  } | undefined {
    for (let startLine = searchFromLine; startLine >= minLine; startLine -= 1) {
      const startText = document.lineAt(startLine).text;
      if (!/^\s*(?:final\s+|override\s+|private\s+|protected\s+|implicit\s+|inline\s+)*def\s+[A-Za-z_][A-Za-z0-9_]*/.test(startText)) {
        continue;
      }

      const lines: Array<{ readonly line: number; readonly text: string }> = [];
      let parenDepth = 0;
      let sawOpeningParen = false;

      for (let line = startLine; line < Math.min(document.lineCount, startLine + 40); line += 1) {
        const text = document.lineAt(line).text;
        lines.push({ line, text });

        for (const ch of text) {
          if (ch === '(') {
            parenDepth += 1;
            sawOpeningParen = true;
          } else if (ch === ')' && parenDepth > 0) {
            parenDepth -= 1;
          }
        }

        if (sawOpeningParen && parenDepth === 0 && /\s*=\s*|\{/.test(text)) {
          return {
            startLine,
            lines
          };
        }

        if (line > startLine && /\s*=\s*|\{/.test(text) && !sawOpeningParen) {
          break;
        }
      }
    }

    return undefined;
  }

  private hasLocalIdentifierContext(
    document: vscode.TextDocument,
    tokenText: string,
    originLine: number
  ): boolean {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenText)) {
      return false;
    }

    const windowStart = Math.max(0, originLine - 120);
    const windowEnd = Math.min(document.lineCount - 1, originLine + 8);
    const tokenPattern = new RegExp(`\\b${escapeRegExp(tokenText)}\\b`);

    for (let line = windowStart; line <= windowEnd; line += 1) {
      const text = document.lineAt(line).text;
      if (!tokenPattern.test(text)) {
        continue;
      }

      if (/\bdef\b|\bval\b|\bvar\b|\bgiven\b/.test(text) || text.includes(':')) {
        return true;
      }
    }

    return false;
  }

  private extractParameterNames(signatureText: string): readonly string[] {
    const names = new Set<string>();
    const parameterPattern = /(?:^|[,(])\s*(?:implicit\s+|using\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
    let match = parameterPattern.exec(signatureText);
    while (match) {
      names.add(match[1]);
      match = parameterPattern.exec(signatureText);
    }

    return Array.from(names);
  }

  private findNameInSignatureLines(
    lines: ReadonlyArray<{ readonly line: number; readonly text: string }>,
    symbolName: string
  ): vscode.Position | undefined {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(symbolName)})(?=\\s*:)`);
    for (const entry of lines) {
      const match = entry.text.match(pattern);
      if (!match || typeof match.index !== 'number') {
        continue;
      }

      const prefixLength = match[1]?.length ?? 0;
      return new vscode.Position(entry.line, match.index + prefixLength);
    }

    return undefined;
  }

  private resolveStageBSameFileTopLevel(
    document: vscode.TextDocument,
    originSnapshot: ResolutionOriginSnapshot
  ): StageResolutionResult {
    const symbols = this.symbolIndexManager.getSymbolsForFile(document.uri)
      .filter((symbol) => symbol.symbolName === originSnapshot.tokenText && symbol.lineNumber - 1 !== originSnapshot.originLine)
      .filter((symbol) => {
        const lineIndex = Math.max(0, symbol.lineNumber - 1);
        if (lineIndex >= document.lineCount) {
          return false;
        }

        return indentationWidth(document.lineAt(lineIndex).text) === 0;
      })
      .sort((left, right) => compareSymbols(left, right));

    return {
      stage: 'B',
      confidence: symbols.length === 1 ? 'high' : (symbols.length > 1 ? 'medium' : 'low'),
      candidates: symbols
    };
  }

  private async resolveStageCImportAware(
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken
  ): Promise<StageResolutionResult> {
    if (token.isCancellationRequested) {
      return {
        stage: 'C',
        confidence: 'low',
        candidates: []
      };
    }

    const imports = this.symbolIndexManager.getImportsForFile(originSnapshot.originDocumentUri);
    const explicitImportMatches: IndexedSymbol[] = [];
    const wildcardImportMatches: IndexedSymbol[] = [];

    for (const importRecord of imports) {
      if (!importRecord.isWildcard) {
        if (importRecord.importedName !== originSnapshot.tokenText) {
          continue;
        }

        const sourceSymbolName = importRecord.sourceSymbolName ?? importRecord.importedName;
        if (!sourceSymbolName) {
          continue;
        }

        const matched = await this.symbolIndexManager.querySymbolsInPackage(
          sourceSymbolName,
          importRecord.packagePath,
          300,
          token
        );

        explicitImportMatches.push(...matched);
        continue;
      }

      const packageExists = await this.symbolIndexManager.packageExists(importRecord.packagePath, token);
      if (!packageExists) {
        this.traceStage(
          {
            stage: 'C',
            confidence: 'low',
            candidates: []
          },
          originSnapshot,
          `wildcard import — external package, skipped (${importRecord.packagePath})`
        );
        continue;
      }

      const sameProjectPackageSymbols = await this.symbolIndexManager.querySymbolsInPackage(
        originSnapshot.tokenText,
        importRecord.packagePath,
        300,
        token
      );

      if (sameProjectPackageSymbols.length > 0) {
        wildcardImportMatches.push(...sameProjectPackageSymbols);
      }
    }

    const deduped = new Map<string, IndexedSymbol>();
    for (const symbol of [...explicitImportMatches, ...wildcardImportMatches]) {
      const key = `${symbol.filePath}:${symbol.lineNumber}:${symbol.symbolName}:${symbol.symbolKind}`;
      if (!deduped.has(key)) {
        deduped.set(key, symbol);
      }
    }

    const candidates = Array.from(deduped.values()).sort((left, right) => compareSymbols(left, right));

    let confidence: StageConfidence = 'low';
    if (explicitImportMatches.length === 1) {
      confidence = 'high';
    } else if (explicitImportMatches.length > 1) {
      confidence = 'medium';
    } else if (wildcardImportMatches.length === 1) {
      confidence = 'high';
    } else if (wildcardImportMatches.length > 1) {
      confidence = 'medium';
    }

    return {
      stage: 'C',
      confidence,
      candidates
    };
  }

  private async resolveStageDSamePackage(
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken
  ): Promise<StageResolutionResult> {
    if (token.isCancellationRequested) {
      return {
        stage: 'D',
        confidence: 'low',
        candidates: []
      };
    }

    const exactLocalCandidates = await this.symbolIndexManager.querySymbolsInPackage(
      originSnapshot.tokenText,
      originSnapshot.originPackageName,
      300,
      token
    );

    const sortedCandidates = [...exactLocalCandidates].sort((left, right) => compareSymbols(left, right));

    return {
      stage: 'D',
      confidence: sortedCandidates.length === 1 ? 'high' : (sortedCandidates.length > 1 ? 'medium' : 'low'),
      candidates: sortedCandidates
    };
  }

  private async resolveStageEModuleIndex(
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken
  ): Promise<StageResolutionResult> {
    const nativeMatches = await this.symbolIndexManager.searchSymbols(originSnapshot.tokenText, 300, token);
    
    const candidates = nativeMatches
      .filter((symbol) => symbol.symbolName === originSnapshot.tokenText)
      .sort((left, right) => compareSymbols(left, right));

    this.logger.debug('SEARCH', `Indexed candidates for '${originSnapshot.tokenText}': native=${nativeMatches.length}, final=${candidates.length}.`);

    return {
      stage: 'E',
      confidence: candidates.length === 1 ? 'high' : (candidates.length > 1 ? 'medium' : 'low'),
      candidates
    };
  }

  private async resolveStageFTextSearch(
    document: vscode.TextDocument,
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken
  ): Promise<StageResolutionResult> {
    const location = await this.findTextSearchDefinition(document, originSnapshot.tokenText, token);
    if (!location) {
      return {
        stage: 'F',
        confidence: 'low',
        candidates: []
      };
    }

    return {
      stage: 'F',
      confidence: 'low',
      candidates: [{
        symbolName: originSnapshot.tokenText,
        symbolKind: 'def',
        filePath: location.uri.fsPath,
        lineNumber: location.range.start.line + 1,
        packageName: originSnapshot.originPackageName,
        visibility: 'unknown'
      }]
    };
  }

  private async showIndexedCandidateChooser(
    originSnapshot: ResolutionOriginSnapshot,
    candidates: readonly IndexedSymbol[],
    stage: StageResolutionResult['stage']
  ): Promise<IndexedSymbol | undefined> {
    const sortedCandidates = [...candidates].sort(
      stage === 'A' || stage === 'B'
        ? compareSymbolsWithCursorProximity(originSnapshot.originLine + 1)
        : (left, right) => compareSymbols(left, right)
    );
    const reason = stageReasonBadge(stage);

    const picked = await vscode.window.showQuickPick(
      sortedCandidates.map((entry) => ({
        label: `${symbolKindCodicon(entry.symbolKind)} ${entry.symbolName} — ${vscode.workspace.asRelativePath(vscode.Uri.file(entry.filePath), false)}:${entry.lineNumber}`,
        description: entry.packageName || entry.containerName,
        detail: `[${reason}] ${entry.symbolKind} • ${entry.visibility}${entry.visibility === 'private' ? ' • ⚠️ private' : ''}`,
        entry
      })),
      {
        title: vscode.l10n.t('{0} definitions for `{1}`', sortedCandidates.length, originSnapshot.tokenText),
        matchOnDescription: true,
        matchOnDetail: true
      }
    );

    if (picked?.entry) {
      this.recordStickyChoice(originSnapshot, picked.entry);
    }

    return picked?.entry;
  }

  private makeStickyCacheKey(originSnapshot: ResolutionOriginSnapshot): string {
    return `${originSnapshot.originFilePath}::${originSnapshot.tokenText}::${originSnapshot.originLine}`;
  }

  private recordStickyChoice(originSnapshot: ResolutionOriginSnapshot, selected: IndexedSymbol): void {
    const key = this.makeStickyCacheKey(originSnapshot);
    if (this.stickyChoiceCache.has(key)) {
      this.stickyChoiceCache.delete(key);
    }

    this.stickyChoiceCache.set(key, {
      targetFilePath: selected.filePath,
      targetLineNumber: selected.lineNumber,
      symbolName: selected.symbolName
    });

    while (this.stickyChoiceCache.size > STICKY_CACHE_LIMIT) {
      const oldest = this.stickyChoiceCache.keys().next().value;
      if (!oldest) {
        break;
      }

      this.stickyChoiceCache.delete(oldest);
    }
  }

  private invalidateStickyEntriesForTargetFile(filePath: string): void {
    const keysToDelete: string[] = [];
    for (const [key, entry] of this.stickyChoiceCache.entries()) {
      if (entry.targetFilePath === filePath) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.stickyChoiceCache.delete(key);
    }
  }

  private async resolveFromStickyCache(
    originSnapshot: ResolutionOriginSnapshot,
    token: vscode.CancellationToken
  ): Promise<DefinitionResolution | undefined> {
    const stickyEnabled = vscode.workspace.getConfiguration('scalaLite').get<boolean>('goToDefinition.stickyCache.enabled', true);
    const stickyBypass = vscode.workspace.getConfiguration('scalaLite').get<boolean>('goToDefinition.stickyCache.bypass', false);
    if (!stickyEnabled || stickyBypass) {
      return undefined;
    }

    const key = this.makeStickyCacheKey(originSnapshot);
    const entry = this.stickyChoiceCache.get(key);
    if (!entry) {
      this.traceStickyCache('miss', originSnapshot);
      return undefined;
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const targetStillValid = await this.isStickyTargetValid(entry, token);
    if (!targetStillValid) {
      this.stickyChoiceCache.delete(key);
      this.traceStickyCache('evict-stale', originSnapshot);
      return undefined;
    }

    this.stickyChoiceCache.delete(key);
    this.stickyChoiceCache.set(key, entry);
    this.traceStickyCache('hit', originSnapshot);
    return {
      location: toLocation(entry.targetFilePath, entry.targetLineNumber),
      confidence: 'high',
      source: 'indexed'
    };
  }

  private async isStickyTargetValid(entry: StickyChoiceEntry, token: vscode.CancellationToken): Promise<boolean> {
    const fileSymbols = this.symbolIndexManager.getSymbolsForFile(vscode.Uri.file(entry.targetFilePath));
    if (fileSymbols.some((symbol) => symbol.lineNumber === entry.targetLineNumber && symbol.symbolName === entry.symbolName)) {
      return true;
    }

    const matches = await this.symbolIndexManager.searchSymbols(entry.symbolName, 400, token);
    return matches.some((symbol) => symbol.filePath === entry.targetFilePath && symbol.lineNumber === entry.targetLineNumber);
  }

  private traceStickyCache(event: 'hit' | 'miss' | 'evict-stale', originSnapshot: ResolutionOriginSnapshot): void {
    const traceEnabled = vscode.workspace.getConfiguration('scalaLite').get<boolean>('traceResolution', false);
    if (!traceEnabled) {
      return;
    }

    this.logger.debug('SEARCH', `[traceResolution] sticky-cache ${event} symbol=${originSnapshot.tokenText}`);
  }

  private traceStage(result: StageResolutionResult, originSnapshot: ResolutionOriginSnapshot, extra?: string): void {
    const traceEnabled = vscode.workspace.getConfiguration('scalaLite').get<boolean>('traceResolution', false);
    if (!traceEnabled) {
      return;
    }

    this.logger.debug(
      'SEARCH',
      `[traceResolution] stage=${result.stage} symbol=${originSnapshot.tokenText} confidence=${result.confidence} candidates=${result.candidates.length}${extra ? ` ${extra}` : ''}`
    );
  }

  private traceTokenExtraction(
    document: vscode.TextDocument,
    position: vscode.Position,
    wordRange: vscode.Range,
    tokenText: string
  ): void {
    const traceEnabled = vscode.workspace.getConfiguration('scalaLite').get<boolean>('traceResolution', false);
    if (!traceEnabled) {
      return;
    }

    const lineText = document.lineAt(position.line).text.trim();
    this.logger.debug(
      'SEARCH',
      `[traceResolution] token='${tokenText}' range=(${wordRange.start.line}:${wordRange.start.character}-${wordRange.end.line}:${wordRange.end.character}) cursor=(${position.line}:${position.character}) line='${lineText}'`
    );
  }

  private findSameFileDefinition(
    document: vscode.TextDocument,
    symbolName: string,
    currentLine: number
  ): vscode.Location | undefined {
    const symbols = this.symbolIndexManager.getSymbolsForFile(document.uri);
    const sameFileCandidates = symbols
      .filter((symbol) => symbol.symbolName === symbolName && symbol.lineNumber - 1 !== currentLine)
      .filter((symbol) => symbol.symbolKind !== 'param')
      .map((symbol) => ({
        symbol,
        lineIndex: Math.max(0, symbol.lineNumber - 1),
        lineDistance: Math.abs((symbol.lineNumber - 1) - currentLine),
        signedDistance: (symbol.lineNumber - 1) - currentLine,
        indentWidth: symbol.lineNumber - 1 < document.lineCount
          ? indentationWidth(document.lineAt(Math.max(0, symbol.lineNumber - 1)).text)
          : 0,
        indentStyle: symbol.lineNumber - 1 < document.lineCount
          ? detectIndentationStyle(document.lineAt(Math.max(0, symbol.lineNumber - 1)).text)
          : 'none' as const
      }));

    if (sameFileCandidates.length === 0) {
      return undefined;
    }

    const currentLineText = document.lineAt(currentLine).text;
    const currentIndentWidth = indentationWidth(currentLineText);

    const aboveEnclosing = sameFileCandidates
      .filter((entry) => entry.signedDistance < 0 && entry.indentWidth <= currentIndentWidth)
      .sort((left, right) => {
        if (left.indentWidth !== right.indentWidth) {
          return right.indentWidth - left.indentWidth;
        }

        if (left.lineDistance !== right.lineDistance) {
          return left.lineDistance - right.lineDistance;
        }

        return right.lineIndex - left.lineIndex;
      })[0];

    if (aboveEnclosing) {
      return toLocation(aboveEnclosing.symbol.filePath, aboveEnclosing.symbol.lineNumber);
    }

    const belowSameBlock = sameFileCandidates
      .filter((entry) => entry.signedDistance > 0 && entry.indentWidth === currentIndentWidth)
      .sort((left, right) => {
        if (left.lineDistance !== right.lineDistance) {
          return left.lineDistance - right.lineDistance;
        }

        return left.lineIndex - right.lineIndex;
      })[0];

    if (belowSameBlock) {
      return toLocation(belowSameBlock.symbol.filePath, belowSameBlock.symbol.lineNumber);
    }

    return undefined;
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
    const prioritizedFileUris = await this.prioritizeTextSearchFiles(fileUris, symbolName, token);
    const matches: Array<{ readonly uri: vscode.Uri; readonly line: number; readonly packageName: string; readonly preview: string }> = [];

    for (const fileUri of prioritizedFileUris) {
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

  private async prioritizeTextSearchFiles(
    fileUris: readonly vscode.Uri[],
    symbolName: string,
    token: vscode.CancellationToken
  ): Promise<readonly vscode.Uri[]> {
    if (fileUris.length <= 1 || token.isCancellationRequested) {
      return fileUris;
    }

    const nativeMatches = await this.symbolIndexManager.searchSymbols(symbolName, 400, token);
    const prioritizedPathSet = new Set(
      nativeMatches
        .filter((symbol) => symbol.symbolName === symbolName)
        .map((symbol) => path.resolve(symbol.filePath))
    );

    if (prioritizedPathSet.size === 0) {
      return fileUris;
    }

    const prioritized: vscode.Uri[] = [];
    const remaining: vscode.Uri[] = [];

    for (const fileUri of fileUris) {
      if (prioritizedPathSet.has(path.resolve(fileUri.fsPath))) {
        prioritized.push(fileUri);
        continue;
      }

      remaining.push(fileUri);
    }

    if (prioritized.length === 0) {
      return fileUris;
    }

    return [...prioritized, ...remaining];
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
