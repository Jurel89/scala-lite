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

  const results = await session.detectAll(folders, force, vscode.workspace);
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
  logger: StructuredLogger
): Promise<void> {
  logger.info('ACTIVATE', `Switching mode to ${mode}.`);
  if (mode === 'A') {
    return;
  }

  await detectWorkspaceBuildTools(detectionSession, buildToolState, logger, false);
}

export function activate(context: vscode.ExtensionContext): void {
  const logger = new StructuredLogger('INFO');
  void readLogLevelFromWorkspaceConfig().then((level) => {
    if (level) {
      logger.setLevel(level);
      logger.info('CONFIG', `Log level set to ${level} from workspace config.`);
    }
  });
  logger.info('ACTIVATE', 'Extension activation started.');

  const buildToolDetectionSession = new BuildToolDetectionSession();
  const buildToolState = new Map<string, BuildTool>();

  const getBuildToolForUri = (uri: vscode.Uri): BuildTool => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return 'none';
    }

    return buildToolState.get(folder.uri.toString()) ?? 'none';
  };

  const getPrimaryDetectedBuildTool = (): BuildTool => {
    const first = vscode.workspace.workspaceFolders?.[0];
    if (!first) {
      return 'none';
    }

    return buildToolState.get(first.uri.toString()) ?? 'none';
  };

  const profileManager = new ProfileManager(context, getPrimaryDetectedBuildTool);

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
    onModeChanged: async (mode) => onModeChanged(mode, buildToolDetectionSession, buildToolState, logger),
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
    }
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

  context.subscriptions.push(
    runIdleAuditDisposable,
    reDetectBuildToolDisposable,
    copyDiagnosticBundleDisposable,
    logger,
    buildDiagnosticsRunner,
    profileManager,
    modeManager,
    ...scalafmtDisposables,
    ...scalafixDisposables,
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
  logger.info('ACTIVATE', 'Extension activation completed.');
}

export function deactivate(): void {
  // No background workers or watchers are started by default.
}