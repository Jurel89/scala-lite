import * as vscode from 'vscode';
import {
  BuildToolDetectionResult,
  BuildToolDetectionSession
} from './buildToolDetector';
import { BuildTool } from './buildToolInference';
import { runIdleCpuAudit } from './idleCpuAudit';
import { ModeManager } from './modeManager';
import { WorkspaceMode } from './modePresentation';
import {
  registerRunMainCommandsWithExecutor,
  RunMainCodeLensProvider
} from './runMainFeature';
import {
  registerRunTestCommandsWithExecutor,
  RunTestCodeLensProvider
} from './runTestFeature';
import { BuildDiagnosticsRunner } from './buildDiagnostics';
import { readLogLevelFromWorkspaceConfig } from './workspaceConfig';
import { StructuredLogger } from './structuredLogger';
import { createDiagnosticBundle } from './diagnosticBundle';
import { ProfileManager } from './profileManager';
import { registerScalafmtFeature } from './scalafmtFeature';
import { registerScalafixFeature } from './scalafixFeature';
import { validateIgnoreRulesAtActivation } from './ignoreRules';
import { registerWorkspaceConfigFeature } from './workspaceConfigFeature';
import { registerWorkspaceDoctorFeature } from './workspaceDoctorFeature';
import { getNativeEngine, initializeNativeEngine, registerNativeEngineFeature } from './nativeEngineState';
import {
  ACTIVATION_BUDGET_MS,
  recordActivationDuration,
  registerActivationPerformanceFeature
} from './activationPerformance';
import { auditMemoryBudgetForMode, registerMemoryBudgetFeature } from './memoryBudget';
import { SymbolIndexManager } from './symbolIndex';
import { GoToDefinitionProvider } from './goToDefinitionFeature';
import { WorkspaceSymbolSearchProvider } from './workspaceSymbolFeature';
import { FindUsagesProvider } from './findUsagesFeature';
import { SyntaxDiagnosticsController } from './syntaxDiagnosticsFeature';

const IDLE_AUDIT_DURATION_MS = 30_000;

function renderDetectionSummary(results: readonly BuildToolDetectionResult[]): string {
  return results
    .map((result) => `${result.workspaceFolder.name}: ${result.buildTool}`)
    .join(', ');
}

function notifyBuildDetection(results: readonly BuildToolDetectionResult[]): void {
  const notDetected = results.filter((result) => result.buildTool === 'none');
  if (notDetected.length > 0) {
    vscode.window.setStatusBarMessage(vscode.l10n.t('No build tool detected'), 5000);
    return;
  }

  const summary = renderDetectionSummary(results);
  vscode.window.setStatusBarMessage(vscode.l10n.t('Detected build tools: {0}', summary), 5000);
}

async function detectWorkspaceBuildTools(
  session: BuildToolDetectionSession,
  state: Map<string, BuildTool>,
  logger: StructuredLogger,
  force: boolean
): Promise<BuildToolDetectionResult[]> {
  const startedAt = Date.now();
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    logger.info('CONFIG', 'No workspace folders available for build-tool detection.');
    return [];
  }

  let results: BuildToolDetectionResult[];
  try {
    results = await session.detectAll(folders, force, vscode.workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('CONFIG', `Build-tool detection failed. Falling back to none. ${message}`);
    vscode.window.setStatusBarMessage(vscode.l10n.t('⚠ Fallback mode (slower)'), 5000);
    results = folders.map((workspaceFolder) => ({
      workspaceFolder,
      buildTool: 'none' as BuildTool
    }));
  }

  for (const result of results) {
    state.set(result.workspaceFolder.uri.toString(), result.buildTool);
  }
  notifyBuildDetection(results);
  logger.info('CONFIG', `Detected build tools for ${results.length} workspace folder(s).`, Date.now() - startedAt);
  return results;
}

async function onModeChanged(
  mode: WorkspaceMode,
  detectionSession: BuildToolDetectionSession,
  buildToolState: Map<string, BuildTool>,
  logger: StructuredLogger,
  symbolIndexManager: SymbolIndexManager
): Promise<void> {
  logger.info('ACTIVATE', `Switching mode to ${mode}.`);
  await symbolIndexManager.setMode(mode);
  auditMemoryBudgetForMode(mode, logger);

  if (mode === 'A') {
    return;
  }

  await detectWorkspaceBuildTools(detectionSession, buildToolState, logger, false);
}

export function activate(context: vscode.ExtensionContext): void {
  const activationStartedAt = Date.now();
  const logger = new StructuredLogger('INFO');
  void readLogLevelFromWorkspaceConfig().then((level) => {
    if (level) {
      logger.setLevel(level);
      logger.info('CONFIG', `Log level set to ${level} from workspace config.`);
    }
  });
  void validateIgnoreRulesAtActivation(logger);
  initializeNativeEngine(logger);
  logger.info('ACTIVATE', 'Extension activation started.');

  const buildToolDetectionSession = new BuildToolDetectionSession();
  const buildToolState = new Map<string, BuildTool>();
  let buildIntegrationEnabled = true;
  let activeMode: WorkspaceMode = 'A';

  const getBuildToolForUri = (uri: vscode.Uri): BuildTool => {
    if (!buildIntegrationEnabled) {
      return 'none';
    }

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return 'none';
    }

    return buildToolState.get(folder.uri.toString()) ?? 'none';
  };

  const getPrimaryDetectedBuildTool = (): BuildTool => {
    if (!buildIntegrationEnabled) {
      return 'none';
    }

    const first = vscode.workspace.workspaceFolders?.[0];
    if (!first) {
      return 'none';
    }

    return buildToolState.get(first.uri.toString()) ?? 'none';
  };

  const profileManager = new ProfileManager(context, getPrimaryDetectedBuildTool);
  const symbolIndexManager = new SymbolIndexManager(logger, () => getNativeEngine());
  symbolIndexManager.initialize(context);
  const definitionProvider = new GoToDefinitionProvider(symbolIndexManager, () => activeMode, logger);
  const workspaceSymbolProvider = new WorkspaceSymbolSearchProvider(symbolIndexManager, () => activeMode);
  const referenceProvider = new FindUsagesProvider(symbolIndexManager, () => activeMode);
  const syntaxDiagnosticsController = new SyntaxDiagnosticsController(symbolIndexManager, () => activeMode, logger);

  const editorAccessDisposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) {
      workspaceSymbolProvider.recordFileAccess(editor.document.uri);
    }
  });
  const openDocumentAccessDisposable = vscode.workspace.onDidOpenTextDocument((document) => {
    workspaceSymbolProvider.recordFileAccess(document.uri);
  });

  const runMainProvider = new RunMainCodeLensProvider({
    getBuildToolForUri,
    getActiveProfile: () => profileManager.getActiveProfile()
  });
  const runTestProvider = new RunTestCodeLensProvider({
    getBuildToolForUri,
    getActiveProfile: () => profileManager.getActiveProfile()
  });
  const buildDiagnosticsRunner = new BuildDiagnosticsRunner(logger);
  const modeManager = new ModeManager(context, {
    onModeChanged: async (mode) => {
      activeMode = mode;
      await onModeChanged(mode, buildToolDetectionSession, buildToolState, logger, symbolIndexManager);
      await syntaxDiagnosticsController.refreshOpenDocuments();
    },
    getBuildIntegrationLabel: () => getPrimaryDetectedBuildTool(),
    onBuildIntegrationChanged: async (enabled) => {
      buildIntegrationEnabled = enabled;

      if (!enabled) {
        buildToolState.clear();
        return;
      }

      await detectWorkspaceBuildTools(buildToolDetectionSession, buildToolState, logger, false);
    },
    registerAdditionalProvidersForMode: (mode) => {
      if (mode === 'A') {
        return [];
      }

      return [
        vscode.languages.registerCodeLensProvider(
          [{ language: 'scala' }, { pattern: '**/*.sbt' }],
          runMainProvider
        ),
        vscode.languages.registerCodeLensProvider(
          [{ language: 'scala' }],
          runTestProvider
        )
      ];
    },
    definitionProvider,
    workspaceSymbolProvider,
    referenceProvider
  });

  const runIdleAuditDisposable = vscode.commands.registerCommand('scalaLite.runIdleCpuAudit', async () => {
    vscode.window.showInformationMessage(
      vscode.l10n.t('Scala Lite idle CPU audit started (30s). Keep the workspace idle for accurate measurement.')
    );

    const result = await runIdleCpuAudit(IDLE_AUDIT_DURATION_MS);

    const summary = vscode.l10n.t(
      'Scala Lite idle CPU audit result — duration: {0}s, CPU delta: {1}μs, approx CPU: {2}%.',
      String(result.durationSeconds),
      String(result.cpuDeltaMicros),
      String(result.approximateCpuPercent)
    );

    vscode.window.showInformationMessage(summary);
  });

  const reDetectBuildToolDisposable = vscode.commands.registerCommand('scalaLite.reDetectBuildTool', async () => {
    await detectWorkspaceBuildTools(buildToolDetectionSession, buildToolState, logger, true);
    vscode.window.showInformationMessage(vscode.l10n.t('Build tool re-detection completed.'));
  });

  const copyDiagnosticBundleDisposable = vscode.commands.registerCommand('scalaLite.copyDiagnosticBundle', async () => {
    const extensionVersion = String(context.extension.packageJSON.version ?? '0.0.0');
    const bundleUri = await createDiagnosticBundle(logger.getLastLines(500), extensionVersion);
    await vscode.commands.executeCommand('revealFileInOS', bundleUri);
    vscode.window.showInformationMessage(vscode.l10n.t('Diagnostic bundle created at: {0}', bundleUri.fsPath));
    logger.info('DIAG', `Diagnostic bundle created: ${bundleUri.fsPath}`);
  });

  const runMainCommandDisposables = registerRunMainCommandsWithExecutor(
    {
      getBuildToolForUri,
      getActiveProfile: () => profileManager.getActiveProfile()
    },
    async (command, uri) => buildDiagnosticsRunner.runCommand(command, uri, 'Scala Lite: Run')
  );
  const runTestCommandDisposables = registerRunTestCommandsWithExecutor(
    {
      getBuildToolForUri,
      getActiveProfile: () => profileManager.getActiveProfile()
    },
    async (command, uri) => buildDiagnosticsRunner.runCommand(command, uri, 'Scala Lite: Test')
  );
  const scalafmtDisposables = registerScalafmtFeature(logger);
  const scalafixDisposables = registerScalafixFeature(logger);
  const workspaceConfigDisposables = registerWorkspaceConfigFeature({
    logger,
    modeManager,
    profileManager,
    getDefaultBuildTool: getPrimaryDetectedBuildTool
  });
  const workspaceDoctorDisposables = registerWorkspaceDoctorFeature({
    getBuildTool: getPrimaryDetectedBuildTool,
    getPrioritizedFolderRoots: () => {
      const symbolCountsByFolder = new Map<string, number>();
      for (const symbol of symbolIndexManager.getAllSymbols()) {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(symbol.filePath));
        if (!folder) {
          continue;
        }

        const key = folder.uri.fsPath;
        symbolCountsByFolder.set(key, (symbolCountsByFolder.get(key) ?? 0) + 1);
      }

      return Array.from(symbolCountsByFolder.entries())
        .sort((left, right) => right[1] - left[1])
        .map(([folderPath]) => folderPath);
    },
    onPrioritizationApplied: (prioritizedFolderCount, totalFolderCount) => {
      logger.info(
        'DIAG',
        `Workspace Doctor prioritized folder scan order for ${prioritizedFolderCount}/${totalFolderCount} folder(s).`
      );
    }
  });
  const nativeEngineDisposables = registerNativeEngineFeature(logger);
  const activationPerformanceDisposables = registerActivationPerformanceFeature();
  const memoryBudgetDisposables = registerMemoryBudgetFeature(() => activeMode, logger);

  context.subscriptions.push(
    runIdleAuditDisposable,
    reDetectBuildToolDisposable,
    copyDiagnosticBundleDisposable,
    editorAccessDisposable,
    openDocumentAccessDisposable,
    logger,
    buildDiagnosticsRunner,
    profileManager,
    symbolIndexManager,
    syntaxDiagnosticsController,
    modeManager,
    ...scalafmtDisposables,
    ...scalafixDisposables,
    ...workspaceDoctorDisposables,
    ...nativeEngineDisposables,
    ...activationPerformanceDisposables,
    ...memoryBudgetDisposables,
    ...workspaceConfigDisposables,
    ...runMainCommandDisposables,
    ...runTestCommandDisposables
  );

  vscode.window.setStatusBarMessage(
    vscode.l10n.t('Scala Lite activated in Mode A (event-driven only).'),
    3000
  );

  void (async () => {
    await detectWorkspaceBuildTools(buildToolDetectionSession, buildToolState, logger, false);
    await profileManager.initialize();
  })();
  void modeManager.initialize();
  void syntaxDiagnosticsController.refreshOpenDocuments();
  const activationElapsed = Date.now() - activationStartedAt;
  recordActivationDuration(activationElapsed, logger);
  if (activationElapsed > ACTIVATION_BUDGET_MS) {
    vscode.window.setStatusBarMessage(
      vscode.l10n.t('Activation exceeded budget: {0}ms (> {1}ms).', String(activationElapsed), String(ACTIVATION_BUDGET_MS)),
      4000
    );
  }

  logger.info('ACTIVATE', 'Extension activation completed.');
}

export function deactivate(): void {
  // No background workers or watchers are started by default.
}