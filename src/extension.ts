import * as vscode from 'vscode';
import {
  BuildToolDetectionResult,
  BuildToolDetectionSession,
  detectClasspathProvider
} from './buildToolDetector';
import { BuildTool } from './buildToolInference';
import { runIdleCpuAudit } from './idleCpuAudit';
import { ModeManager } from './modeManager';
import { WorkspaceMode } from './modePresentation';
import { redactSensitiveOutput } from './buildCommandExecutor';
import {
  openOrCreateWorkspaceConfig,
  readBuildConfigFromWorkspaceConfig,
  readDependencyConfigFromWorkspaceConfig,
  readLogLevelFromWorkspaceConfig,
  getWorkspaceConfigSourceLabel,
  writeClasspathProviderToWorkspaceConfig
} from './workspaceConfig';
import {
  registerRunMainCommandsWithExecutor,
  RunMainCodeLensProvider
} from './runMainFeature';
import {
  registerRunTestCommandsWithExecutor,
  RunTestCodeLensProvider
} from './runTestFeature';
import { BuildDiagnosticsRunner } from './buildDiagnostics';
import { StructuredLogger } from './structuredLogger';
import { createDiagnosticBundle } from './diagnosticBundle';
import { ProfileManager } from './profileManager';
import { registerScalafmtFeature } from './scalafmtFeature';
import { registerScalafixFeature } from './scalafixFeature';
import { validateIgnoreRulesAtActivation } from './ignoreRules';
import { registerWorkspaceConfigFeature } from './workspaceConfigFeature';
import { registerWorkspaceDoctorFeature } from './workspaceDoctorFeature';
import {
  getNativeEngine,
  getNativeEngineStatus,
  initializeNativeEngine,
  registerNativeEngineFeature
} from './nativeEngineState';
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
import { HoverInfoProvider } from './hoverInfoFeature';
import { ensureScalaLiteCacheDir, getScalaLiteCacheSummary, resetScalaLiteCache } from './scalaLiteCache';
import { fetchDependencyArtifacts, readDependencyAttachmentSummary } from './dependencyArtifacts';
import { resolveJdkModules } from './jdkResolver';
import {
  prepareClasspathSync,
  readDependencySyncStatus,
  syncMavenClasspathWithJdk,
  syncSbtClasspathWithJdk,
  writeDependencySyncFailure
} from './dependencySyncOrchestrator';

const COMMAND_SYNC_CLASSPATH = 'scalaLite.syncClasspath';
const COMMAND_FETCH_DEPENDENCY_SOURCES = 'scalaLite.fetchDependencySources';
const COMMAND_DEPENDENCY_STATUS = 'scalaLite.dependencyStatus';
const COMMAND_DEPENDENCY_JDK_STATUS = 'scalaLite.dependencyJdkStatus';
const COMMAND_RESET_DEPENDENCY_CACHE = 'scalaLite.resetDependencyCache';
const COMMAND_OPEN_DEPENDENCY_ATTACHMENT = 'scalaLite.openDependencyAttachment';

const IDLE_AUDIT_DURATION_MS = 30_000;
const MODE_C_BUDGET_AUDIT_INTERVAL_MS = 60_000;
const BUDGET_NOTIFICATION_DEBOUNCE_MS = 5 * 60_000;

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
  await auditMemoryBudgetForMode(mode, logger, symbolIndexManager.getMemoryBudgetMetrics());

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
  const hoverProvider = new HoverInfoProvider(definitionProvider, () => activeMode, logger);
  const workspaceSymbolProvider = new WorkspaceSymbolSearchProvider(symbolIndexManager, () => activeMode);
  const referenceProvider = new FindUsagesProvider(symbolIndexManager, () => activeMode);
  const syntaxDiagnosticsController = new SyntaxDiagnosticsController(symbolIndexManager, () => activeMode, logger);
  let modeCBudgetAuditTimer: ReturnType<typeof setInterval> | undefined;
  let lastBudgetViolationNotificationAt = 0;

  const configureModeCBudgetAuditTimer = (): void => {
    if (modeCBudgetAuditTimer) {
      clearInterval(modeCBudgetAuditTimer);
      modeCBudgetAuditTimer = undefined;
    }

    if (activeMode !== 'C') {
      return;
    }

    modeCBudgetAuditTimer = setInterval(() => {
      void runMemoryAuditWithFeedback();
    }, MODE_C_BUDGET_AUDIT_INTERVAL_MS);
  };

  const openMemoryBudgetConfig = async (): Promise<void> => {
    const document = await openOrCreateWorkspaceConfig(getPrimaryDetectedBuildTool());
    if (!document) {
      return;
    }

    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const text = document.getText();
    const memoryIndex = text.indexOf('"memory"');
    const budgetsIndex = text.indexOf('"budgets"');
    const targetIndex = memoryIndex >= 0 ? memoryIndex : Math.max(0, budgetsIndex);
    const target = document.positionAt(targetIndex);
    editor.selection = new vscode.Selection(target, target);
    editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
  };

  const runMemoryAuditWithFeedback = async (): Promise<void> => {
    if (activeMode !== 'C') {
      return;
    }

    const result = await auditMemoryBudgetForMode(activeMode, logger, symbolIndexManager.getMemoryBudgetMetrics());
    const severeOverage = result.exceeded && result.combinedUsedBytes > (result.combinedBudgetBytes * 1.5);
    if (!severeOverage) {
      return;
    }

    const now = Date.now();
    if (now - lastBudgetViolationNotificationAt < BUDGET_NOTIFICATION_DEBOUNCE_MS) {
      return;
    }

    lastBudgetViolationNotificationAt = now;

    const toMb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);
    const switchAction = vscode.l10n.t('Switch to Mode B');
    const increaseAction = vscode.l10n.t('Increase Budget');
    const dismissAction = vscode.l10n.t('Dismiss');

    const picked = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Scala Lite memory usage ({0}MB) exceeds budget ({1}MB) for this workspace (deps hot: {2}MB/{3}MB). Consider switching to Mode B or configuring a larger budget.',
        toMb(result.combinedUsedBytes),
        toMb(result.combinedBudgetBytes),
        toMb(result.dependencyUsedBytes),
        toMb(result.maxDependencyBytes)
      ),
      switchAction,
      increaseAction,
      dismissAction
    );

    if (picked === switchAction) {
      await modeManager.switchModeForAutomation('B');
      return;
    }

    if (picked === increaseAction) {
      await openMemoryBudgetConfig();
    }
  };

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
      configureModeCBudgetAuditTimer();
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
    hoverProvider,
    workspaceSymbolProvider,
    referenceProvider,
    getNativeEngineStatusLabel: () => getNativeEngineStatus(),
    getConfigSourceLabel: () => getWorkspaceConfigSourceLabel()
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

  const syncClasspathDisposable = vscode.commands.registerCommand(COMMAND_SYNC_CLASSPATH, async () => {
    if (activeMode !== 'C') {
      vscode.window.showWarningMessage(vscode.l10n.t('Switch to Mode C to enable dependency indexing.'));
      return;
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder before syncing classpath.'));
      return;
    }

    const buildConfig = await readBuildConfigFromWorkspaceConfig();
    const dependencyConfig = await readDependencyConfigFromWorkspaceConfig();

    if (!dependencyConfig.enabled) {
      vscode.window.showInformationMessage(vscode.l10n.t('Dependency indexing is disabled in workspace configuration.'));
      return;
    }

    let selectedProvider: 'maven' | 'sbt' | undefined;
    const prepared = await prepareClasspathSync(
      folder,
      buildConfig,
      async (providers) => {
        const picked = await vscode.window.showQuickPick(
          providers.map((provider) => ({
            label: provider === 'sbt' ? 'SBT' : 'Maven',
            provider
          })),
          {
            title: vscode.l10n.t('Both SBT and Maven detected. Choose classpath provider.'),
            ignoreFocusOut: true
          }
        );
        if (picked?.provider === 'maven' || picked?.provider === 'sbt') {
          selectedProvider = picked.provider;
          await writeClasspathProviderToWorkspaceConfig(picked.provider);
        }

        return picked?.provider;
      }
    );

    if (prepared.provider === 'none') {
      vscode.window.showWarningMessage(vscode.l10n.t('No Maven or SBT project detected in the workspace root.'));
      return;
    }

    const selectedModule = prepared.provider === 'maven'
      ? (prepared.modules.length === 1
        ? prepared.modules[0]
        : await vscode.window.showQuickPick(
          prepared.modules.map((module) => ({
            label: module.artifactId,
            description: module.path,
            detail: module.packaging,
            module
          })),
          {
            title: vscode.l10n.t('Select Maven module for classpath sync'),
            ignoreFocusOut: true
          }
        ).then((picked) => picked?.module))
      : undefined;

    if (prepared.provider === 'maven' && prepared.modules.length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('No Maven modules found. Ensure pom.xml exists at workspace root.'));
      return;
    }

    if (prepared.provider === 'maven' && !selectedModule) {
      return;
    }

    await ensureScalaLiteCacheDir(folder);
    const startedAt = Date.now();

    try {
      const status = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: true,
          title: vscode.l10n.t('Resolving classpath...')
        },
        async (progress, token) => {
          progress.report({ message: prepared.provider === 'sbt'
            ? vscode.l10n.t('Running SBT classpath resolution')
            : vscode.l10n.t('Running Maven dependency:build-classpath')
          });
          const resolved = prepared.provider === 'sbt'
            ? await syncSbtClasspathWithJdk({
              workspaceFolder: folder,
              buildConfig,
              dependencyConfig,
              cancellationToken: token,
              onOutput: (line) => {
                const safeLine = redactSensitiveOutput(line).trim();
                if (safeLine.length > 0) {
                  logger.info('RUN', safeLine);
                }
              }
            })
            : await syncMavenClasspathWithJdk({
              workspaceFolder: folder,
              module: selectedModule!,
              buildConfig,
              dependencyConfig,
              cancellationToken: token,
              onOutput: (line) => {
                const safeLine = redactSensitiveOutput(line).trim();
                if (safeLine.length > 0) {
                  logger.info('RUN', safeLine);
                }
              }
            });

          return resolved;
        }
      );

      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Classpath synced for {0}: {1} entries cached, JDK modules selected: {2}.',
          status.moduleArtifactId ?? selectedModule?.artifactId ?? folder.name,
          String(status.jarsCount),
          String(status.selectedJdkModuleCount)
        )
      );
      if (selectedProvider) {
        logger.info('CONFIG', `Classpath provider selection persisted: ${selectedProvider}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeDependencySyncFailure(folder, prepared.provider, message, startedAt);
      if (/ENOENT|not found/i.test(message) && prepared.provider === 'maven') {
        vscode.window.showErrorMessage(vscode.l10n.t('Maven not found. Install Maven or add a project wrapper (mvnw).'));
        return;
      }

      if (/ENOENT|not found/i.test(message) && prepared.provider === 'sbt') {
        vscode.window.showErrorMessage(vscode.l10n.t('SBT not found. Install SBT or add an sbt launcher script at workspace root.'));
        return;
      }

      vscode.window.showErrorMessage(vscode.l10n.t('Classpath sync failed: {0}', message));
    }
  });

  const fetchDependencySourcesDisposable = vscode.commands.registerCommand(COMMAND_FETCH_DEPENDENCY_SOURCES, async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder before fetching dependency sources.'));
      return;
    }

    const buildConfig = await readBuildConfigFromWorkspaceConfig();
    const dependencyConfig = await readDependencyConfigFromWorkspaceConfig();
    if (!dependencyConfig.enabled) {
      vscode.window.showInformationMessage(vscode.l10n.t('Dependency indexing is disabled in workspace configuration.'));
      return;
    }

    const providerResult = await detectClasspathProvider(folder, { preferred: buildConfig.classpathProvider });
    if (providerResult.provider === 'none') {
      vscode.window.showWarningMessage(vscode.l10n.t('No Maven or SBT project detected in the workspace root.'));
      return;
    }
    const detectedProvider: 'maven' | 'sbt' = providerResult.provider;

    try {
      const summary = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          cancellable: true,
          title: vscode.l10n.t('Fetching dependency sources...')
        },
        async (progress, token) => {
          progress.report({ message: providerResult.provider === 'maven'
            ? vscode.l10n.t('Running Maven dependency:sources and javadoc resolution')
            : vscode.l10n.t('Running SBT updateClassifiers')
          });

          return fetchDependencyArtifacts({
            workspaceFolder: folder,
            provider: detectedProvider,
            buildConfig,
            cancellationToken: token,
            onOutput: (line) => {
              const safeLine = redactSensitiveOutput(line).trim();
              if (safeLine.length > 0) {
                logger.info('RUN', safeLine);
              }
            }
          });
        }
      );

      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Dependency artifacts updated: sources {0}/{1}, javadocs {2}/{1}.',
          String(summary.attachedSources),
          String(summary.totalJars),
          String(summary.attachedJavadocs)
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not found/i.test(message) && detectedProvider === 'maven') {
        vscode.window.showErrorMessage(vscode.l10n.t('Maven not found. Install Maven or add a project wrapper (mvnw).'));
        return;
      }

      if (/ENOENT|not found/i.test(message) && detectedProvider === 'sbt') {
        vscode.window.showErrorMessage(vscode.l10n.t('SBT not found. Install SBT or add an sbt launcher script at workspace root.'));
        return;
      }

      vscode.window.showErrorMessage(vscode.l10n.t('Dependency source fetch failed: {0}', message));
    }
  });

  const dependencyStatusDisposable = vscode.commands.registerCommand(COMMAND_DEPENDENCY_STATUS, async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder to inspect dependency index status.'));
      return;
    }

    const buildConfig = await readBuildConfigFromWorkspaceConfig();
    const providerResult = await detectClasspathProvider(folder, { preferred: buildConfig.classpathProvider });
    const cacheSummary = await getScalaLiteCacheSummary(folder);
    const cacheMb = (cacheSummary.totalBytes / (1024 * 1024)).toFixed(2);
    const status = await readDependencySyncStatus(folder);
    const attachmentSummary = await readDependencyAttachmentSummary(folder);
    const statusLabel = status
      ? (status.success
        ? vscode.l10n.t('last run succeeded ({0} jars)', String(status.jarsCount))
        : vscode.l10n.t('last run failed'))
      : vscode.l10n.t('no sync run recorded');
    const attachmentLabel = attachmentSummary
      ? vscode.l10n.t('sources {0}/{1}, javadocs {2}/{1}', String(attachmentSummary.attachedSources), String(attachmentSummary.totalJars), String(attachmentSummary.attachedJavadocs))
      : vscode.l10n.t('no source attachments');

    vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Dependency status — provider: {0}, cache: {1}, size: {2} MB, status: {3}, attachments: {4}.',
        providerResult.provider,
        cacheSummary.exists ? 'present' : 'missing',
        cacheMb,
        statusLabel,
        attachmentLabel
      )
    );
  });

  const dependencyJdkStatusDisposable = vscode.commands.registerCommand(COMMAND_DEPENDENCY_JDK_STATUS, async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage(vscode.l10n.t('Open a workspace folder to inspect JDK dependency status.'));
      return;
    }

    const buildConfig = await readBuildConfigFromWorkspaceConfig();
    const dependencyConfig = await readDependencyConfigFromWorkspaceConfig();
    const jdkStatus = await resolveJdkModules(folder, buildConfig.jdkHome, dependencyConfig.jdkModules);

    vscode.window.showInformationMessage(
      vscode.l10n.t(
        'JDK dependency status — source: {0}, home: {1}, modules selected: {2}, modules available: {3}.',
        jdkStatus.source,
        jdkStatus.home ?? 'n/a',
        String(jdkStatus.selectedModules.length),
        String(jdkStatus.availableModules.length)
      )
    );
  });

  const resetDependencyCacheDisposable = vscode.commands.registerCommand(COMMAND_RESET_DEPENDENCY_CACHE, async () => {
    const didReset = await resetScalaLiteCache();
    if (!didReset) {
      vscode.window.showInformationMessage(vscode.l10n.t('No .scala-lite cache directory found to reset.'));
      return;
    }

    vscode.window.showInformationMessage(vscode.l10n.t('Scala Lite dependency cache reset.'));
  });

  const openDependencyAttachmentDisposable = vscode.commands.registerCommand(COMMAND_OPEN_DEPENDENCY_ATTACHMENT, async (artifactPath?: string) => {
    if (typeof artifactPath !== 'string' || artifactPath.trim().length === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('Dependency artifact path is missing.'));
      return;
    }

    const uri = vscode.Uri.file(artifactPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      vscode.window.showWarningMessage(vscode.l10n.t('Dependency artifact not found: {0}', artifactPath));
      return;
    }

    try {
      await vscode.commands.executeCommand('revealFileInOS', uri);
      return;
    } catch {
    }

    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch {
      await vscode.env.openExternal(uri);
    }
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
  // GUARDRAIL: Workspace Doctor MUST NOT run on activation by default.
  // It stays user-triggered unless workspaceDoctor.autoRunOnOpen is explicitly enabled.
  const workspaceDoctorDisposables = registerWorkspaceDoctorFeature({
    logger,
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
  const memoryBudgetDisposables = registerMemoryBudgetFeature(
    () => activeMode,
    () => symbolIndexManager.getMemoryBudgetMetrics(),
    () => symbolIndexManager.getMemoryBreakdown(),
    logger
  );
  const modeCRebuildAuditDisposable = symbolIndexManager.onDidModeCRebuildCompleted(() => {
    void runMemoryAuditWithFeedback();
  });
  const modeCBudgetTimerDisposable = new vscode.Disposable(() => {
    if (modeCBudgetAuditTimer) {
      clearInterval(modeCBudgetAuditTimer);
      modeCBudgetAuditTimer = undefined;
    }
  });

  context.subscriptions.push(
    runIdleAuditDisposable,
    reDetectBuildToolDisposable,
    copyDiagnosticBundleDisposable,
    syncClasspathDisposable,
    fetchDependencySourcesDisposable,
    dependencyStatusDisposable,
    dependencyJdkStatusDisposable,
    resetDependencyCacheDisposable,
    openDependencyAttachmentDisposable,
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
    modeCRebuildAuditDisposable,
    modeCBudgetTimerDisposable,
    ...workspaceConfigDisposables,
    ...runMainCommandDisposables,
    ...runTestCommandDisposables
  );

  vscode.window.setStatusBarMessage(
    vscode.l10n.t('Scala Lite activated.'),
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