import * as vscode from 'vscode';
import {
  getModeDefinition,
  getModeText,
  MODES,
  WorkspaceMode
} from './modePresentation';
import {
  readModuleFolderFromWorkspaceConfig,
  readDefaultModeFromWorkspaceConfig,
  writeIndexedModuleFolderToWorkspaceConfig
} from './workspaceConfig';

const MODE_STORAGE_KEY = 'scalaLite.workspaceMode';
const MODULE_STORAGE_KEY = 'scalaLite.indexedModuleFolder';

export const COMMAND_PICK_MODE = 'scalaLite.pickWorkspaceMode';
export const COMMAND_SWITCH_MODE_A = 'scalaLite.switchModeA';
export const COMMAND_SWITCH_MODE_B = 'scalaLite.switchModeB';
export const COMMAND_SWITCH_MODE_C = 'scalaLite.switchModeC';

const DIAGNOSTICS_STORAGE_KEY = 'scalaLite.diagnosticsLevel';
const BUILD_INTEGRATION_STORAGE_KEY = 'scalaLite.buildIntegrationEnabled';

type DiagnosticsLevel = 'off' | 'syntax';

type GovernorSelection =
  | 'index:off'
  | 'index:open-files'
  | 'index:module'
  | 'diagnostics:off'
  | 'diagnostics:syntax'
  | 'build:off'
  | 'build:on';

interface GovernorQuickPickItem extends vscode.QuickPickItem {
  readonly selection?: GovernorSelection;
}


function ensureWorkspaceMode(value: unknown): WorkspaceMode | undefined {
  if (value === 'A' || value === 'B' || value === 'C') {
    return value;
  }

  return undefined;
}

function toRelativePath(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string {
  return vscode.workspace.asRelativePath(uri, false).replace(`${folder.name}/`, '');
}

function selectorForScala(): vscode.DocumentSelector {
  return [{ language: 'scala' }, { pattern: '**/*.sbt' }];
}

export interface ModeManagerOptions {
  readonly onModeChanged?: (mode: WorkspaceMode) => void | Promise<void>;
  readonly registerAdditionalProvidersForMode?: (mode: WorkspaceMode) => vscode.Disposable[];
  readonly getBuildIntegrationLabel?: () => string;
  readonly onBuildIntegrationChanged?: (enabled: boolean) => void | Promise<void>;
  readonly definitionProvider?: vscode.DefinitionProvider;
  readonly workspaceSymbolProvider?: vscode.WorkspaceSymbolProvider;
  readonly referenceProvider?: vscode.ReferenceProvider;
}

export class ModeManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly options: ModeManagerOptions;
  private readonly statusBarItem: vscode.StatusBarItem;
  private activeMode: WorkspaceMode = 'A';
  private diagnosticsLevel: DiagnosticsLevel = 'syntax';
  private buildIntegrationEnabled = true;
  private activeModeDisposables: vscode.Disposable[] = [];

  public constructor(context: vscode.ExtensionContext, options: ModeManagerOptions = {}) {
    this.context = context;
    this.options = options;
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = COMMAND_PICK_MODE;
    this.context.subscriptions.push(this.statusBarItem);
  }

  public async initialize(): Promise<void> {
    this.registerCommands();
    this.statusBarItem.show();

    const storedDiagnostics = this.context.workspaceState.get<DiagnosticsLevel>(DIAGNOSTICS_STORAGE_KEY);
    this.diagnosticsLevel = storedDiagnostics === 'off' ? 'off' : 'syntax';
    this.buildIntegrationEnabled = this.context.workspaceState.get<boolean>(BUILD_INTEGRATION_STORAGE_KEY) !== false;

    const storedMode = ensureWorkspaceMode(this.context.workspaceState.get<string>(MODE_STORAGE_KEY));
    const configuredDefaultMode = ensureWorkspaceMode(await readDefaultModeFromWorkspaceConfig());
    const initialMode = storedMode ?? configuredDefaultMode ?? 'A';

    await this.switchMode(initialMode, false);
  }

  public async reloadFromWorkspaceConfig(): Promise<void> {
    const configuredDefaultMode = ensureWorkspaceMode(await readDefaultModeFromWorkspaceConfig());
    if (!configuredDefaultMode || configuredDefaultMode === this.activeMode) {
      return;
    }

    await this.switchMode(configuredDefaultMode, false);
  }

  public isBuildIntegrationEnabled(): boolean {
    return this.buildIntegrationEnabled;
  }

  public dispose(): void {
    this.releaseModeResources();
    this.statusBarItem.dispose();
  }

  private registerCommands(): void {
    const pickModeCommand = vscode.commands.registerCommand(COMMAND_PICK_MODE, async () => {
      const picked = await vscode.window.showQuickPick<GovernorQuickPickItem>(
        this.getGovernorQuickPickItems(),
        {
          title: vscode.l10n.t('Scala Lite Control Governor')
        }
      );

      if (!picked?.selection) {
        return;
      }

      await this.applyGovernorSelection(picked.selection);
    });

    const modeACommand = vscode.commands.registerCommand(COMMAND_SWITCH_MODE_A, async () => {
      await this.switchMode('A', true);
    });
    const modeBCommand = vscode.commands.registerCommand(COMMAND_SWITCH_MODE_B, async () => {
      await this.switchMode('B', true);
    });
    const modeCCommand = vscode.commands.registerCommand(COMMAND_SWITCH_MODE_C, async () => {
      await this.switchMode('C', true);
    });

    this.context.subscriptions.push(pickModeCommand, modeACommand, modeBCommand, modeCCommand);
  }

  private getGovernorQuickPickItems(): readonly GovernorQuickPickItem[] {
    return [
      {
        label: vscode.l10n.t('Index'),
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: vscode.l10n.t('Off'),
        description: this.activeMode === 'A' ? vscode.l10n.t('Current') : undefined,
        selection: 'index:off'
      },
      {
        label: vscode.l10n.t('Open Files'),
        description: this.activeMode === 'B' ? vscode.l10n.t('Current') : undefined,
        selection: 'index:open-files'
      },
      {
        label: vscode.l10n.t('Module'),
        description: this.activeMode === 'C' ? vscode.l10n.t('Current') : undefined,
        selection: 'index:module'
      },
      {
        label: vscode.l10n.t('Diagnostics'),
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: vscode.l10n.t('Off'),
        description: this.diagnosticsLevel === 'off' ? vscode.l10n.t('Current') : undefined,
        selection: 'diagnostics:off'
      },
      {
        label: vscode.l10n.t('Syntax Only'),
        description: this.diagnosticsLevel === 'syntax' ? vscode.l10n.t('Current') : undefined,
        selection: 'diagnostics:syntax'
      },
      {
        label: vscode.l10n.t('Build Integration'),
        kind: vscode.QuickPickItemKind.Separator
      },
      {
        label: vscode.l10n.t('Off'),
        description: !this.buildIntegrationEnabled ? vscode.l10n.t('Current') : undefined,
        selection: 'build:off'
      },
      {
        label: vscode.l10n.t('On'),
        description: this.buildIntegrationEnabled ? vscode.l10n.t('Current') : undefined,
        selection: 'build:on'
      }
    ];
  }

  private async applyGovernorSelection(selection: GovernorSelection): Promise<void> {
    if (selection === 'index:off') {
      await this.switchMode('A', true);
      return;
    }

    if (selection === 'index:open-files') {
      if (!(await this.confirmScopeIncrease('B'))) {
        return;
      }
      await this.switchMode('B', true);
      return;
    }

    if (selection === 'index:module') {
      if (!(await this.confirmScopeIncrease('C'))) {
        return;
      }
      await this.switchMode('C', true);
      return;
    }

    if (selection === 'diagnostics:off' || selection === 'diagnostics:syntax') {
      this.diagnosticsLevel = selection === 'diagnostics:off' ? 'off' : 'syntax';
      await this.context.workspaceState.update(DIAGNOSTICS_STORAGE_KEY, this.diagnosticsLevel);
      this.updateStatusBar(this.activeMode);
      return;
    }

    if (selection === 'build:off' || selection === 'build:on') {
      this.buildIntegrationEnabled = selection === 'build:on';
      await this.context.workspaceState.update(BUILD_INTEGRATION_STORAGE_KEY, this.buildIntegrationEnabled);
      if (this.options.onBuildIntegrationChanged) {
        await this.options.onBuildIntegrationChanged(this.buildIntegrationEnabled);
      }
      this.updateStatusBar(this.activeMode);
    }
  }

  private async confirmScopeIncrease(targetMode: WorkspaceMode): Promise<boolean> {
    const currentRank = this.scopeRank(this.activeMode);
    const targetRank = this.scopeRank(targetMode);

    if (targetRank <= currentRank) {
      return true;
    }

    const action = await vscode.window.showWarningMessage(
      vscode.l10n.t('Increasing index scope may increase CPU and memory usage. Continue?'),
      vscode.l10n.t('Continue'),
      vscode.l10n.t('Cancel')
    );

    return action === vscode.l10n.t('Continue');
  }

  private scopeRank(mode: WorkspaceMode): number {
    if (mode === 'A') {
      return 0;
    }

    if (mode === 'B') {
      return 1;
    }

    return 2;
  }

  private async switchMode(targetMode: WorkspaceMode, userInitiated: boolean): Promise<void> {
    const startedAt = Date.now();

    if (targetMode === 'C') {
      const selectedFolder = await this.ensureIndexedModuleFolder(userInitiated);
      if (!selectedFolder) {
        return;
      }
    }

    this.releaseModeResources();
    this.activeMode = targetMode;
    this.activeModeDisposables = this.registerProvidersForMode(targetMode);
    this.updateStatusBar(targetMode);

    await this.context.workspaceState.update(MODE_STORAGE_KEY, targetMode);

    if (this.options.onModeChanged) {
      await this.options.onModeChanged(targetMode);
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 200) {
      vscode.window.setStatusBarMessage(vscode.l10n.t('Scala Lite mode switch took {0}ms', String(elapsedMs)), 3000);
    }
  }

  private updateStatusBar(mode: WorkspaceMode): void {
    const details = getModeDefinition(mode);
    const indexLabel = mode === 'A' ? 'Off' : mode === 'B' ? 'Open Files' : 'Module';
    const diagnosticsLabel = this.diagnosticsLevel === 'off' ? 'Off' : 'Syntax';
    const detectedBuild = this.options.getBuildIntegrationLabel?.() ?? 'none';
    const buildLabel = this.buildIntegrationEnabled ? detectedBuild : 'Off';

    this.statusBarItem.text = `SL: [Index: ${indexLabel}] [Diag: ${diagnosticsLabel}] [Build: ${buildLabel}]`;
    this.statusBarItem.tooltip = `${details.text} ${details.description}\n${details.impact}`;
  }

  private releaseModeResources(): void {
    for (const disposable of this.activeModeDisposables) {
      disposable.dispose();
    }

    this.activeModeDisposables = [];
  }

  private registerProvidersForMode(mode: WorkspaceMode): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    const selector = selectorForScala();

    if (this.options.referenceProvider) {
      const referenceProvider = vscode.languages.registerReferenceProvider(selector, this.options.referenceProvider);
      disposables.push(referenceProvider);
    }

    if (mode === 'B' || mode === 'C') {
      const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(selector, {
        provideDocumentSymbols(): vscode.DocumentSymbol[] {
          return [];
        }
      });

      const codeLensProvider = vscode.languages.registerCodeLensProvider(selector, {
        provideCodeLenses(): vscode.CodeLens[] {
          return [];
        }
      });

      const definitionProvider = vscode.languages.registerDefinitionProvider(selector, {
        provideDefinition: (...args) => {
          if (this.options.definitionProvider) {
            return this.options.definitionProvider.provideDefinition(...args);
          }

          return [];
        }
      });

      const workspaceSymbolProvider = this.options.workspaceSymbolProvider
        ? vscode.languages.registerWorkspaceSymbolProvider(this.options.workspaceSymbolProvider)
        : undefined;

      disposables.push(documentSymbolProvider, codeLensProvider, definitionProvider);
      if (workspaceSymbolProvider) {
        disposables.push(workspaceSymbolProvider);
      }
    }

    if (this.options.registerAdditionalProvidersForMode) {
      disposables.push(...this.options.registerAdditionalProvidersForMode(mode));
    }

    return disposables;
  }

  private async ensureIndexedModuleFolder(userInitiated: boolean): Promise<vscode.Uri | undefined> {
    const existing = this.context.workspaceState.get<string>(MODULE_STORAGE_KEY);
    if (existing) {
      return vscode.Uri.parse(existing);
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    const configuredRelativePath = await readModuleFolderFromWorkspaceConfig();
    if (configuredRelativePath) {
      const configuredUri = vscode.Uri.joinPath(workspaceFolder.uri, configuredRelativePath);
      try {
        const stat = await vscode.workspace.fs.stat(configuredUri);
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          await this.context.workspaceState.update(MODULE_STORAGE_KEY, configuredUri.toString());
          return configuredUri;
        }
      } catch {
      }
    }

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: workspaceFolder.uri,
      openLabel: vscode.l10n.t('Select module folder for Mode C')
    });

    const picked = selected?.[0];
    if (!picked) {
      if (userInitiated) {
        vscode.window.showInformationMessage(vscode.l10n.t('Mode C requires selecting a module folder.'));
      }
      return undefined;
    }

    const owningFolder = vscode.workspace.getWorkspaceFolder(picked);
    if (!owningFolder) {
      vscode.window.showWarningMessage(vscode.l10n.t('Selected folder must be inside the current workspace.'));
      return undefined;
    }

    await this.context.workspaceState.update(MODULE_STORAGE_KEY, picked.toString());
    await writeIndexedModuleFolderToWorkspaceConfig(toRelativePath(picked, owningFolder));

    return picked;
  }
}