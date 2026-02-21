import * as vscode from 'vscode';
import { StructuredLogger } from './structuredLogger';
import { ModeManager } from './modeManager';
import { ProfileManager } from './profileManager';
import {
  createOrOverwriteWorkspaceConfig,
  getUnknownTopLevelWorkspaceConfigKeys,
  isWorkspaceConfigDocument,
  openOrCreateWorkspaceConfig,
  refreshWorkspaceConfigSourceState,
  readLogLevelFromWorkspaceConfig,
  readWorkspaceConfigRaw
} from './workspaceConfig';
import { validateIgnoreRulesAtActivation } from './ignoreRules';
import { BuildTool } from './buildToolInference';

export const COMMAND_OPEN_CONFIGURATION = 'scalaLite.openConfiguration';
export const COMMAND_CREATE_CONFIGURATION = 'scalaLite.createConfiguration';

interface WorkspaceConfigFeatureOptions {
  readonly logger: StructuredLogger;
  readonly modeManager: ModeManager;
  readonly profileManager: ProfileManager;
  readonly getDefaultBuildTool: () => BuildTool;
}

async function reloadWorkspaceConfiguration(options: WorkspaceConfigFeatureOptions): Promise<void> {
  await refreshWorkspaceConfigSourceState();
  const config = await readWorkspaceConfigRaw();
  const unknownKeys = getUnknownTopLevelWorkspaceConfigKeys(config);
  if (unknownKeys.length > 0) {
    options.logger.warn('CONFIG', `Unknown config key(s) in .vscode/scala-lite.json: ${unknownKeys.join(', ')}`);
  }

  const level = await readLogLevelFromWorkspaceConfig();
  if (level) {
    options.logger.setLevel(level);
  }

  await validateIgnoreRulesAtActivation(options.logger);
  await options.modeManager.reloadFromWorkspaceConfig();
  await options.profileManager.reloadFromWorkspaceConfig();
  options.modeManager.refreshStatusBar();
}

export function registerWorkspaceConfigFeature(options: WorkspaceConfigFeatureOptions): vscode.Disposable[] {
  const openConfigDisposable = vscode.commands.registerCommand(COMMAND_OPEN_CONFIGURATION, async () => {
    const sourceState = await refreshWorkspaceConfigSourceState();
    if (sourceState.source === 'merged' && sourceState.hasOverlappingOverrides) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Note: .vscode/scala-lite.json takes precedence over VS Code Settings for overlapping properties.')
      );
    }

    const document = await openOrCreateWorkspaceConfig(options.getDefaultBuildTool());
    if (!document) {
      return;
    }

    await vscode.window.showTextDocument(document, {
      preview: false
    });
  });

  const saveWatcherDisposable = vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (!isWorkspaceConfigDocument(document)) {
      return;
    }

    try {
      await reloadWorkspaceConfiguration(options);

      vscode.window.setStatusBarMessage(vscode.l10n.t('Scala Lite configuration reloaded.'), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn('CONFIG', `Failed to reload .vscode/scala-lite.json: ${message}`);
    }
  });

  const createConfigDisposable = vscode.commands.registerCommand(COMMAND_CREATE_CONFIGURATION, async () => {
    const createAttempt = await createOrOverwriteWorkspaceConfig(options.getDefaultBuildTool(), false);
    if (!createAttempt.uri) {
      return;
    }

    if (!createAttempt.written && createAttempt.exists) {
      const action = await vscode.window.showWarningMessage(
        vscode.l10n.t('.vscode/scala-lite.json already exists. Overwrite it with a fresh scaffold?'),
        vscode.l10n.t('Overwrite'),
        vscode.l10n.t('Cancel')
      );

      if (action !== vscode.l10n.t('Overwrite')) {
        const existing = await vscode.workspace.openTextDocument(createAttempt.uri);
        await vscode.window.showTextDocument(existing, { preview: false });
        return;
      }

      const overwriteResult = await createOrOverwriteWorkspaceConfig(options.getDefaultBuildTool(), true);
      if (!overwriteResult.written) {
        return;
      }
    }

    const document = await vscode.workspace.openTextDocument(createAttempt.uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const firstKeyIndex = Math.max(0, document.getText().indexOf('"mode"'));
    const firstPosition = document.positionAt(firstKeyIndex);
    editor.selection = new vscode.Selection(firstPosition, firstPosition);
    editor.revealRange(new vscode.Range(firstPosition, firstPosition));
  });

  const settingsWatcherDisposable = vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration('scalaLite')) {
      return;
    }

    try {
      await reloadWorkspaceConfiguration(options);
      vscode.window.setStatusBarMessage(vscode.l10n.t('Scala Lite settings reloaded.'), 2000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn('CONFIG', `Failed to reload settings from VS Code configuration: ${message}`);
    }
  });

  const configFileWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/scala-lite.json');
  const onConfigFileChanged = async (): Promise<void> => {
    try {
      await reloadWorkspaceConfiguration(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger.warn('CONFIG', `Failed to refresh config source state: ${message}`);
    }
  };

  const fileCreatedDisposable = configFileWatcher.onDidCreate(onConfigFileChanged);
  const fileDeletedDisposable = configFileWatcher.onDidDelete(onConfigFileChanged);

  void reloadWorkspaceConfiguration(options);

  return [
    openConfigDisposable,
    createConfigDisposable,
    saveWatcherDisposable,
    settingsWatcherDisposable,
    configFileWatcher,
    fileCreatedDisposable,
    fileDeletedDisposable
  ];
}
