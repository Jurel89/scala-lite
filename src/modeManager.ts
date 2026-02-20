import * as vscode from 'vscode';
import {
  getModeDefinition,
  getModeText,
  MODES,
  WorkspaceMode
} from './modePresentation';
import {
  readDefaultModeFromWorkspaceConfig,
  writeIndexedModuleFolderToWorkspaceConfig
} from './workspaceConfig';

const MODE_STORAGE_KEY = 'scalaLite.workspaceMode';
const MODULE_STORAGE_KEY = 'scalaLite.indexedModuleFolder';

export const COMMAND_PICK_MODE = 'scalaLite.pickWorkspaceMode';
export const COMMAND_SWITCH_MODE_A = 'scalaLite.switchModeA';
export const COMMAND_SWITCH_MODE_B = 'scalaLite.switchModeB';
export const COMMAND_SWITCH_MODE_C = 'scalaLite.switchModeC';


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
}

export class ModeManager implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly options: ModeManagerOptions;
  private readonly statusBarItem: vscode.StatusBarItem;
  private activeMode: WorkspaceMode = 'A';
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

    const storedMode = ensureWorkspaceMode(this.context.workspaceState.get<string>(MODE_STORAGE_KEY));
    const configuredDefaultMode = ensureWorkspaceMode(await readDefaultModeFromWorkspaceConfig());
    const initialMode = storedMode ?? configuredDefaultMode ?? 'A';

    await this.switchMode(initialMode, false);
  }

  public dispose(): void {
    this.releaseModeResources();
    this.statusBarItem.dispose();
  }

  private registerCommands(): void {
    const pickModeCommand = vscode.commands.registerCommand(COMMAND_PICK_MODE, async () => {
      const picked = await vscode.window.showQuickPick(
        MODES.map((entry) => ({
          label: entry.text,
          description: entry.description,
          detail: entry.impact,
          mode: entry.mode
        })),
        {
          title: vscode.l10n.t('Scala Lite Workspace Mode')
        }
      );

      if (!picked) {
        return;
      }

      await this.switchMode(picked.mode, true);
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
    this.statusBarItem.text = details.text;
    this.statusBarItem.tooltip = `${details.description}\n${details.impact}`;
  }

  private releaseModeResources(): void {
    for (const disposable of this.activeModeDisposables) {
      disposable.dispose();
    }

    this.activeModeDisposables = [];
  }

  private registerProvidersForMode(mode: WorkspaceMode): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    if (mode === 'B' || mode === 'C') {
      const selector = selectorForScala();

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
        provideDefinition(): vscode.Definition {
          return [];
        }
      });

      disposables.push(documentSymbolProvider, codeLensProvider, definitionProvider);
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