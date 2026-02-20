import * as vscode from 'vscode';
import { StructuredLogger } from './structuredLogger';
import { ModeManager } from './modeManager';
import { ProfileManager } from './profileManager';
import {
  getUnknownTopLevelWorkspaceConfigKeys,
  isWorkspaceConfigDocument,
  openOrCreateWorkspaceConfig,
  readLogLevelFromWorkspaceConfig,
  readWorkspaceConfigRaw
} from './workspaceConfig';
import { validateIgnoreRulesAtActivation } from './ignoreRules';
import { BuildTool } from './buildToolInference';

export const COMMAND_OPEN_CONFIGURATION = 'scalaLite.openConfiguration';

interface WorkspaceConfigFeatureOptions {
  readonly logger: StructuredLogger;
  readonly modeManager: ModeManager;
  readonly profileManager: ProfileManager;
  readonly getDefaultBuildTool: () => BuildTool;
}

async function reloadWorkspaceConfiguration(options: WorkspaceConfigFeatureOptions): Promise<void> {
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
}

export function registerWorkspaceConfigFeature(options: WorkspaceConfigFeatureOptions): vscode.Disposable[] {
  const openConfigDisposable = vscode.commands.registerCommand(COMMAND_OPEN_CONFIGURATION, async () => {
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

  void reloadWorkspaceConfiguration(options);

  return [openConfigDisposable, saveWatcherDisposable];
}
