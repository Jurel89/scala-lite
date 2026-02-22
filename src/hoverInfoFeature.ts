import * as vscode from 'vscode';
import { readDependencyAttachmentForPath } from './dependencyArtifacts';
import { WorkspaceMode } from './modePresentation';
import { IndexedSymbol } from './symbolIndex';
import { StructuredLogger } from './structuredLogger';
import { compareSymbols } from './symbolSort';
import { GoToDefinitionProvider, SharedDefinitionResolution } from './goToDefinitionFeature';
import { hasDependencyIndexCache } from './scalaLiteCache';
import { readDependencyConfigFromWorkspaceConfig } from './workspaceConfig';

function kindLabel(kind: IndexedSymbol['symbolKind']): string {
  if (kind === 'package') {
    return 'package';
  }

  if (kind === 'object') {
    return 'object';
  }

  if (kind === 'class') {
    return 'class';
  }

  if (kind === 'trait') {
    return 'trait';
  }

  if (kind === 'def') {
    return 'def';
  }

  if (kind === 'val') {
    return 'val';
  }

  if (kind === 'param') {
    return 'param';
  }

  return 'type';
}

function toRelativePath(filePath: string): string {
  return vscode.workspace.asRelativePath(filePath, false);
}

function resolveWorkspaceFolderForPath(filePath: string): vscode.WorkspaceFolder | undefined {
  const uri = vscode.Uri.file(filePath);
  return vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
}

function resolveWorkspaceFolderForDocument(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
}

function clampLine(line: number, maxLineCount: number): number {
  if (maxLineCount <= 0) {
    return 0;
  }

  const normalized = Math.max(0, line);
  return Math.min(normalized, maxLineCount - 1);
}

function countMatches(text: string, regex: RegExp): number {
  return (text.match(regex) ?? []).length;
}

function shouldStopAtTopLevelDeclaration(lineText: string): boolean {
  const trimmed = lineText.trimStart();
  return /^(package\s+|import\s+|object\s+|class\s+|trait\s+|enum\s+|def\s+|val\s+|var\s+|type\s+)/.test(trimmed);
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

  if (kind === 'type') {
    return '$(symbol-type-parameter)';
  }

  if (kind === 'package') {
    return '$(package)';
  }

  if (kind === 'val') {
    return '$(symbol-variable)';
  }

  if (kind === 'param') {
    return '$(symbol-parameter)';
  }

  return '$(symbol-method)';
}

function clampPreviewLines(value: number): number {
  return Math.max(0, Math.min(5, value));
}

function isDependencyCandidate(symbol: IndexedSymbol): boolean {
  return symbol.packageName === 'dependency' || symbol.filePath.endsWith('.jar');
}

function isJdkCandidate(symbol: IndexedSymbol): boolean {
  const filePath = symbol.filePath.toLowerCase();
  const pkg = symbol.packageName.toLowerCase();
  return filePath.includes('/jmods/')
    || filePath.includes('\\jmods\\')
    || filePath.endsWith('/lib/rt.jar')
    || filePath.endsWith('\\lib\\rt.jar')
    || pkg.startsWith('java.')
    || pkg.startsWith('javax.')
    || pkg.startsWith('jdk.');
}

function provenanceLabelForSymbol(symbol: IndexedSymbol): 'workspace' | 'dependency' | 'jdk' {
  if (isJdkCandidate(symbol)) {
    return 'jdk';
  }

  if (isDependencyCandidate(symbol)) {
    return 'dependency';
  }

  return 'workspace';
}

function artifactNameFromPath(artifactPath: string): string {
  const normalized = artifactPath.replace(/\\/g, '/');
  return normalized.split('/').pop() ?? artifactPath;
}

function jarVersionHint(jarName: string): string | undefined {
  const versionMatch = jarName.match(/-(\d+(?:\.\d+)*(?:[-.][A-Za-z0-9]+)*)\.jar$/);
  return versionMatch?.[1];
}

function commandLink(command: string, arg?: string): string {
  if (typeof arg !== 'string') {
    return `command:${command}`;
  }

  const encodedArgs = encodeURIComponent(JSON.stringify([arg]));
  return `command:${command}?${encodedArgs}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+!|]/g, '\\$&');
}

async function readDefinitionPreview(filePath: string, lineNumber: number, maxPreviewLines: number): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const targetLine = clampLine(lineNumber - 1, document.lineCount);
    const startLine = targetLine;

    const lines: string[] = [];
    let braceBalance = 0;
    let sawBlockOpener = false;

    for (let line = startLine; line < document.lineCount && lines.length < maxPreviewLines; line += 1) {
      const text = document.lineAt(line).text;

      if (line > startLine && shouldStopAtTopLevelDeclaration(text) && !sawBlockOpener) {
        break;
      }

      lines.push(text);

      const opens = countMatches(text, /\{/g);
      const closes = countMatches(text, /\}/g);

      if (opens > 0) {
        sawBlockOpener = true;
      }

      braceBalance += opens - closes;

      if (sawBlockOpener && braceBalance <= 0 && line > startLine) {
        break;
      }

      if (!sawBlockOpener && line > startLine) {
        const trimmed = text.trim();
        if (trimmed.length === 0 || /[)}]$/.test(trimmed)) {
          break;
        }
      }
    }

    return lines.join('\n').trimEnd();
  } catch {
    return undefined;
  }
}

async function readSignatureLine(filePath: string, lineNumber: number): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    const targetLine = clampLine(lineNumber - 1, document.lineCount);
    return document.lineAt(targetLine).text.trim();
  } catch {
    return undefined;
  }
}

async function readScalaDocAbove(filePath: string, lineNumber: number): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    let cursor = clampLine(lineNumber - 2, document.lineCount);
    if (cursor < 0) {
      return undefined;
    }

    while (cursor >= 0 && document.lineAt(cursor).text.trim().length === 0) {
      cursor -= 1;
    }

    if (cursor < 0 || !document.lineAt(cursor).text.includes('*/')) {
      return undefined;
    }

    const collected: string[] = [];
    for (let line = cursor; line >= Math.max(0, cursor - 40); line -= 1) {
      const text = document.lineAt(line).text;
      collected.unshift(text);
      if (text.includes('/**')) {
        const joined = collected.join('\n');
        return joined.trim();
      }
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export class HoverInfoProvider implements vscode.HoverProvider {
  private readonly definitionResolver: Pick<GoToDefinitionProvider, 'resolveDefinitionCandidates'>;
  private readonly getMode: () => WorkspaceMode;
  private readonly logger: StructuredLogger;

  public constructor(
    definitionResolver: Pick<GoToDefinitionProvider, 'resolveDefinitionCandidates'>,
    getMode: () => WorkspaceMode,
    logger: StructuredLogger
  ) {
    this.definitionResolver = definitionResolver;
    this.getMode = getMode;
    this.logger = logger;
  }

  public async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover | undefined> {
    if (token.isCancellationRequested || this.getMode() === 'A') {
      return undefined;
    }

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      return undefined;
    }

    const symbolName = document.getText(wordRange).trim();
    if (!symbolName) {
      return undefined;
    }

    const resolved = await this.definitionResolver.resolveDefinitionCandidates(document, position, token, {
      includeSticky: true,
      includeTextSearch: true,
      hoverLocalFirstGuard: true
    });

    if (resolved.kind === 'none') {
      this.logger.debug('SEARCH', `Hover: no symbol metadata found for '${symbolName}'. (${resolved.reason})`);
      return this.buildLowConfidenceHover(symbolName, wordRange, document.uri);
    }

    if (resolved.kind === 'multiple') {
      return this.buildAmbiguousHover(symbolName, resolved, wordRange, token);
    }

    if (resolved.kind === 'single' && resolved.confidence !== 'high' && isDependencyCandidate(resolved.symbol)) {
      return this.buildDependencyAwareLowConfidenceHover(symbolName, resolved, wordRange);
    }

    if (resolved.confidence !== 'high') {
      return this.buildLowConfidenceHover(symbolName, wordRange, document.uri);
    }

    return this.buildHighConfidenceHover(document, resolved, wordRange);
  }

  private async buildHighConfidenceHover(
    document: vscode.TextDocument,
    resolved: Extract<SharedDefinitionResolution, { readonly kind: 'single' }>,
    wordRange: vscode.Range
  ): Promise<vscode.Hover> {
    const preferred = resolved.symbol;
    const configuredPreview = vscode.workspace.getConfiguration('scalaLite').get<number>('hover.previewLines', 3);
    const bodyPreviewLines = clampPreviewLines(configuredPreview ?? 3);
    const includeBodyPreview = preferred.filePath === document.uri.fsPath && bodyPreviewLines > 0;

    const [signatureLine, scaladoc, definitionPreview] = await Promise.all([
      readSignatureLine(preferred.filePath, preferred.lineNumber),
      preferred.filePath === document.uri.fsPath ? readScalaDocAbove(preferred.filePath, preferred.lineNumber) : Promise.resolve(undefined),
      includeBodyPreview ? readDefinitionPreview(preferred.filePath, preferred.lineNumber, bodyPreviewLines + 1) : Promise.resolve(undefined)
    ]);

    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`### ${symbolKindCodicon(preferred.symbolKind)} `);
    markdown.appendMarkdown(escapeMarkdown(preferred.symbolName));
    markdown.appendMarkdown('\n\n');
    markdown.appendMarkdown(`**${vscode.l10n.t('Kind')}**: ${kindLabel(preferred.symbolKind)}  \n`);
    markdown.appendMarkdown(`**${vscode.l10n.t('Confidence')}**: ${resolved.confidence.toUpperCase()}  \n`);
    markdown.appendMarkdown(`**${vscode.l10n.t('Defined at')}**: `);
    markdown.appendMarkdown(escapeMarkdown(`${toRelativePath(preferred.filePath)}:${preferred.lineNumber}`));
    markdown.appendMarkdown('  \n');

    const provenance = provenanceLabelForSymbol(preferred);
    const originLabel = provenance === 'jdk'
      ? vscode.l10n.t('JDK')
      : provenance === 'dependency'
        ? vscode.l10n.t('Dependency')
        : vscode.l10n.t('Workspace');
    markdown.appendMarkdown(`**${vscode.l10n.t('Origin')}**: ${originLabel}`);

    let dependencyArtifactPath: string | undefined;
    if (provenance === 'dependency' || provenance === 'jdk') {
      const workspaceFolder = resolveWorkspaceFolderForPath(preferred.filePath);
      const attachment = workspaceFolder
        ? await readDependencyAttachmentForPath(workspaceFolder, preferred.filePath)
        : undefined;
      dependencyArtifactPath = attachment?.jarPath ?? (preferred.filePath.endsWith('.jar') ? preferred.filePath : undefined);
      if (dependencyArtifactPath) {
        const jarName = artifactNameFromPath(dependencyArtifactPath);
        const version = jarVersionHint(jarName);
        markdown.appendMarkdown(` — ${escapeMarkdown(jarName)}`);
        if (version) {
          markdown.appendMarkdown(` (${vscode.l10n.t('version {0}', version)})`);
        }
      }
    }
    markdown.appendMarkdown('  \n');

    if (preferred.containerName) {
      markdown.appendMarkdown(`**${vscode.l10n.t('Container')}**: `);
      markdown.appendMarkdown(escapeMarkdown(preferred.containerName));
      markdown.appendMarkdown('  \n');
    }

    if (preferred.packageName) {
      markdown.appendMarkdown(`**${vscode.l10n.t('Package')}**: `);
      markdown.appendMarkdown(escapeMarkdown(preferred.packageName));
      markdown.appendMarkdown('  \n');
    }

    if (signatureLine) {
      markdown.appendMarkdown(`\n**${vscode.l10n.t('Signature')}**\n`);
      markdown.appendCodeblock(signatureLine, 'scala');
    }

    if (scaladoc) {
      markdown.appendMarkdown(`\n**${vscode.l10n.t('ScalaDoc')}**\n`);
      markdown.appendCodeblock(scaladoc, 'scala');
    }

    if (definitionPreview && includeBodyPreview) {
      markdown.appendMarkdown(`\n**${vscode.l10n.t('Definition')}**\n`);
      markdown.appendCodeblock(definitionPreview, 'scala');
    }

    if (isDependencyCandidate(preferred) || isJdkCandidate(preferred)) {
      const workspaceFolder = resolveWorkspaceFolderForPath(preferred.filePath);
      if (workspaceFolder) {
        const attachment = await readDependencyAttachmentForPath(workspaceFolder, preferred.filePath);
        const hasSources = typeof attachment?.sourcesPath === 'string';

        markdown.isTrusted = true;
        if (hasSources) {
          markdown.appendMarkdown(`\n*${vscode.l10n.t('Sources available — Cmd+click to navigate.')}*\n`);
        } else if (provenance === 'dependency') {
          markdown.appendMarkdown(`\n*${vscode.l10n.t('No sources available —')} [${vscode.l10n.t('Fetch Sources')}](${commandLink('scalaLite.fetchDependencySources')})*\n`);
          if (!signatureLine) {
            markdown.appendMarkdown(`\n**${vscode.l10n.t('Signature')}**\n`);
            markdown.appendCodeblock(`${kindLabel(preferred.symbolKind)} ${preferred.symbolName}`, 'scala');
          }
        } else {
          markdown.appendMarkdown(`\n*${vscode.l10n.t('No sources available —')}*\n`);
          if (!signatureLine) {
            markdown.appendMarkdown(`\n**${vscode.l10n.t('Signature')}**\n`);
            markdown.appendCodeblock(`${kindLabel(preferred.symbolKind)} ${preferred.symbolName}`, 'scala');
          }
        }

        if (attachment) {
          markdown.appendMarkdown(`\n**${vscode.l10n.t('Dependency Artifacts')}**\n`);
          if (attachment.sourcesPath) {
            markdown.appendMarkdown(`- [${vscode.l10n.t('Open sources jar')}](${commandLink('scalaLite.openDependencyAttachment', attachment.sourcesPath)})\n`);
          }
          if (attachment.javadocPath) {
            markdown.appendMarkdown(`- [${vscode.l10n.t('Open javadoc jar')}](${commandLink('scalaLite.openDependencyAttachment', attachment.javadocPath)})\n`);
          }
        }
      }
    }

    return new vscode.Hover(markdown, wordRange);
  }

  private async buildDependencyAwareLowConfidenceHover(
    symbolName: string,
    resolved: Extract<SharedDefinitionResolution, { readonly kind: 'single' }>,
    wordRange: vscode.Range
  ): Promise<vscode.Hover> {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown('### ');
    markdown.appendMarkdown(escapeMarkdown(symbolName));
    markdown.appendMarkdown('\n\n');
    markdown.appendMarkdown(`${vscode.l10n.t('Dependency candidate found from classpath index.')}  \n`);
    markdown.appendMarkdown(`**${vscode.l10n.t('Origin')}**: ${vscode.l10n.t('Dependency')}  \n`);
    markdown.appendMarkdown(`**${vscode.l10n.t('Defined at')}**: `);
    markdown.appendMarkdown(escapeMarkdown(`${toRelativePath(resolved.symbol.filePath)}:${resolved.symbol.lineNumber}`));
    markdown.appendMarkdown('  \n');

    const workspaceFolder = resolveWorkspaceFolderForPath(resolved.symbol.filePath);
    if (workspaceFolder) {
      const attachment = await readDependencyAttachmentForPath(workspaceFolder, resolved.symbol.filePath);
      markdown.isTrusted = true;
      if (attachment?.sourcesPath) {
        markdown.appendMarkdown(`\n*${vscode.l10n.t('Sources available — Cmd+click to navigate.')}*\n`);
      } else {
        markdown.appendMarkdown(`\n*${vscode.l10n.t('No sources available —')} [${vscode.l10n.t('Fetch Sources')}](${commandLink('scalaLite.fetchDependencySources')})*\n`);
      }

      if (attachment?.sourcesPath || attachment?.javadocPath) {
        markdown.appendMarkdown(`\n**${vscode.l10n.t('Dependency Artifacts')}**\n`);
        if (attachment.sourcesPath) {
          markdown.appendMarkdown(`- [${vscode.l10n.t('Open sources jar')}](${commandLink('scalaLite.openDependencyAttachment', attachment.sourcesPath)})\n`);
        }
        if (attachment.javadocPath) {
          markdown.appendMarkdown(`- [${vscode.l10n.t('Open javadoc jar')}](${commandLink('scalaLite.openDependencyAttachment', attachment.javadocPath)})\n`);
        }
      }
    }

    markdown.appendMarkdown(`\n${vscode.l10n.t('Press F12 for navigation options.')} `);
    return new vscode.Hover(markdown, wordRange);
  }

  private async buildAmbiguousHover(
    symbolName: string,
    resolved: Extract<SharedDefinitionResolution, { readonly kind: 'multiple' }>,
    wordRange: vscode.Range,
    token: vscode.CancellationToken
  ): Promise<vscode.Hover> {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown('### ');
    markdown.appendMarkdown(escapeMarkdown(symbolName));
    markdown.appendMarkdown(` — ${vscode.l10n.t('ambiguous ({0} matches)', String(resolved.candidates.length))}\n\n`);
    markdown.appendMarkdown(`${vscode.l10n.t('Top candidates:')}\n`);

    const rankedCandidates = [...resolved.candidates].sort((left, right) => compareSymbols(left, right)).slice(0, 5);
    const previewLines = await Promise.all(
      rankedCandidates.map(async (entry) => {
        if (token.isCancellationRequested) {
          return undefined;
        }

        return readSignatureLine(entry.filePath, entry.lineNumber);
      })
    );

    for (let index = 0; index < rankedCandidates.length; index += 1) {
      const entry = rankedCandidates[index];
      const preview = previewLines[index]?.trim();
      const descriptor = entry.containerName || entry.packageName || '-';
      markdown.appendMarkdown(`- ${symbolKindCodicon(entry.symbolKind)} `);
      markdown.appendMarkdown(escapeMarkdown(entry.symbolName));
      markdown.appendMarkdown(' — ');
      markdown.appendMarkdown(escapeMarkdown(descriptor));
      markdown.appendMarkdown(' — ');
      markdown.appendMarkdown(escapeMarkdown(`${toRelativePath(entry.filePath)}:${entry.lineNumber}`));
      markdown.appendMarkdown('\n');
      if (preview) {
        markdown.appendMarkdown('  - ');
        markdown.appendMarkdown(escapeMarkdown(preview));
        markdown.appendMarkdown('\n');
      }
    }

    const openPicker = vscode.Uri.parse('command:editor.action.revealDefinition').toString();
    markdown.isTrusted = true;
    markdown.appendMarkdown(`\n[${vscode.l10n.t('Open definition picker (F12)')}](${openPicker})`);
    markdown.appendMarkdown(`  \n${vscode.l10n.t('Choosing a definition pins this symbol/location in the sticky cache.')}`);
    return new vscode.Hover(markdown, wordRange);
  }

  private async buildLowConfidenceHover(
    symbolName: string,
    wordRange: vscode.Range,
    documentUri: vscode.Uri
  ): Promise<vscode.Hover> {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.appendMarkdown(`### ${symbolName}\n\n`);

    const workspaceFolder = resolveWorkspaceFolderForDocument(documentUri);
    const mode = this.getMode();
    const dependencyConfig = mode === 'C' ? await readDependencyConfigFromWorkspaceConfig() : undefined;
    if (
      mode === 'C'
      && dependencyConfig?.enabled === true
      && workspaceFolder
      && !(await hasDependencyIndexCache(workspaceFolder))
    ) {
      markdown.isTrusted = true;
      markdown.appendMarkdown(
        `${vscode.l10n.t('Classpath not synced —')} `
        + `[${vscode.l10n.t('Sync Classpath')}](${commandLink('scalaLite.syncClasspath', workspaceFolder.uri.toString())})`
      );
      return new vscode.Hover(markdown, wordRange);
    }

    markdown.appendMarkdown(vscode.l10n.t('Not enough context to show a reliable hover. Press F12.'));
    return new vscode.Hover(markdown, wordRange);
  }
}
