import * as vscode from 'vscode';
import { BuildTool } from './buildToolInference';
import {
  applyProfileCommandShape,
  TaskProfile
} from './profileCore';
import {
  createRunCommandFromInputs,
  detectRunEntryPoints,
  EntryPoint,
  inferFqnForEntry,
  inferPackageName
} from './runMainLogic';
import { getBuildAdapterRegistry } from './buildAdapters';

export const COMMAND_RUN_MAIN_ENTRY = 'scalaLite.runMainEntry';
export const COMMAND_COPY_RUN_COMMAND = 'scalaLite.copyRunCommand';
export const COMMAND_DEBUG_MAIN_ENTRY = 'scalaLite.debugMainEntry';
export const COMMAND_GENERATE_DEBUG_CONFIGURATION = 'scalaLite.generateDebugConfiguration';

const RUN_TERMINAL_NAME = 'Scala Lite: Run';
const DEFAULT_DEBUG_PORT = 5005;
const JAVA_DEBUG_EXTENSION_ID = 'vscjava.vscode-java-debug';
const EXTENSION_INSTALL_WAIT_MS = 15000;

interface RunMainArgs {
  readonly documentUri: string;
  readonly entryLine: number;
}

interface RunMainFeatureOptions {
  readonly getBuildToolForUri: (uri: vscode.Uri) => BuildTool;
  readonly getActiveProfile?: () => TaskProfile;
}

function inferMillModule(document: vscode.TextDocument): string {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) {
    return '__';
  }

  const relativePath = vscode.workspace.asRelativePath(document.uri, false);
  const segments = relativePath.split('/');
  if (segments.length <= 1) {
    return '__';
  }

  return segments.slice(0, -1).join('.').replace(/\./g, '_') || '__';
}

export function createRunCommand(
  buildTool: BuildTool,
  document: vscode.TextDocument,
  entry: EntryPoint,
  profile?: TaskProfile
): string | undefined {
  const packageName = inferPackageName(document.getText());
  const mainClass = inferFqnForEntry(packageName, entry);

  if (profile) {
    const adapter = getBuildAdapterRegistry().resolveFor(buildTool, profile);
    const templated = adapter.runMainCommand(mainClass ?? '', document.uri.fsPath, profile);
    return applyProfileCommandShape(templated, profile);
  }

  return createRunCommandFromInputs(buildTool, document.uri.fsPath, entry, packageName, inferMillModule(document));
}

function terminalForRun(): vscode.Terminal {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === RUN_TERMINAL_NAME);
  if (existing) {
    existing.show(true);
    return existing;
  }

  const terminal = vscode.window.createTerminal({ name: RUN_TERMINAL_NAME });
  terminal.show(true);
  return terminal;
}

function isFileNotFoundError(error: unknown): boolean {
  if (!(error instanceof vscode.FileSystemError)) {
    return false;
  }

  const code = (error as { code?: string }).code;
  if (code === 'FileNotFound' || code === 'EntryNotFound') {
    return true;
  }

  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return name.includes('filenotfound')
    || name.includes('entrynotfound')
    || message.includes('filenotfound')
    || message.includes('entrynotfound');
}

async function waitForExtensionAvailable(extensionId: string, timeoutMs: number): Promise<boolean> {
  if (vscode.extensions.getExtension(extensionId)) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      disposable.dispose();
      resolve(false);
    }, timeoutMs);

    const disposable = vscode.extensions.onDidChange(() => {
      if (!vscode.extensions.getExtension(extensionId)) {
        return;
      }

      clearTimeout(timeout);
      disposable.dispose();
      resolve(true);
    });
  });
}

async function ensureJavaDebugAdapterInstalled(): Promise<boolean> {
  if (vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID)) {
    return true;
  }

  const install = vscode.l10n.t('Install');
  const cancel = vscode.l10n.t('Cancel');
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('Java Debug Adapter extension required.'),
    install,
    cancel
  );

  if (choice !== install) {
    return false;
  }

  await vscode.commands.executeCommand('workbench.extensions.installExtension', JAVA_DEBUG_EXTENSION_ID);
  if (await waitForExtensionAvailable(JAVA_DEBUG_EXTENSION_ID, EXTENSION_INSTALL_WAIT_MS)) {
    return true;
  }

  const reload = vscode.l10n.t('Reload Window');
  const later = vscode.l10n.t('Later');
  const nextStep = await vscode.window.showInformationMessage(
    vscode.l10n.t('Java Debug Adapter installed. Reload window to finish enabling debugging.'),
    reload,
    later
  );

  if (nextStep === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  return Boolean(vscode.extensions.getExtension(JAVA_DEBUG_EXTENSION_ID));
}

function attachDebugConfiguration(name: string, port = DEFAULT_DEBUG_PORT): vscode.DebugConfiguration {
  return {
    type: 'java',
    name,
    request: 'attach',
    hostName: 'localhost',
    port
  };
}

function toDebugCommand(
  buildTool: BuildTool,
  document: vscode.TextDocument,
  entry: EntryPoint,
  profile?: TaskProfile,
  debugPort = DEFAULT_DEBUG_PORT
): string | undefined {
  const packageName = inferPackageName(document.getText());
  const mainClass = inferFqnForEntry(packageName, entry);
  if (!mainClass) {
    return undefined;
  }

  if (profile) {
    const adapter = getBuildAdapterRegistry().resolveFor(buildTool, profile);
    const command = adapter.runMainCommand(mainClass, document.uri.fsPath, profile);

    if (buildTool === 'sbt') {
      return applyProfileCommandShape(`sbt -jvm-debug ${debugPort} "runMain ${mainClass}"`, profile);
    }
    if (buildTool === 'scala-cli') {
      return applyProfileCommandShape(
        `scala-cli run "${document.uri.fsPath}" --java-opt "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${debugPort}"`,
        profile
      );
    }

    return applyProfileCommandShape(command, profile);
  }

  if (buildTool === 'sbt') {
    return `sbt -jvm-debug ${debugPort} "runMain ${mainClass}"`;
  }

  if (buildTool === 'scala-cli') {
    return `scala-cli run "${document.uri.fsPath}" --java-opt "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${debugPort}"`;
  }

  if (buildTool === 'mill') {
    const module = inferMillModule(document);
    return `mill -Djava.vmargs=-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${debugPort} ${module}.runMain ${mainClass}`;
  }

  return undefined;
}

async function upsertLaunchJsonTemplates(): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const vscodeFolderUri = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode');
  const launchJsonUri = vscode.Uri.joinPath(vscodeFolderUri, 'launch.json');
  await vscode.workspace.fs.createDirectory(vscodeFolderUri);

  let launchConfig: { version: string; configurations: vscode.DebugConfiguration[] } = {
    version: '0.2.0',
    configurations: []
  };

  try {
    const current = await vscode.workspace.fs.readFile(launchJsonUri);
    const content = Buffer.from(current).toString('utf8');

    try {
      launchConfig = JSON.parse(content) as { version: string; configurations: vscode.DebugConfiguration[] };
    } catch {
      await vscode.window.showErrorMessage(vscode.l10n.t('Existing .vscode/launch.json contains invalid JSON. Please fix it before adding Scala Lite debug templates.'));
      return;
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(vscode.l10n.t('Unable to read existing .vscode/launch.json: {0}', message));
      return;
    }
  }

  const templates: vscode.DebugConfiguration[] = [
    {
      ...attachDebugConfiguration('Scala Lite: sbt Run (Attach)')
    },
    {
      ...attachDebugConfiguration('Scala Lite: sbt Test (Attach)')
    },
    {
      ...attachDebugConfiguration('Scala Lite: scala-cli Run (Attach)')
    }
  ];

  const existingConfigurations = Array.isArray(launchConfig.configurations)
    ? launchConfig.configurations
    : [];
  const existingNames = new Set(existingConfigurations.map((configuration) => configuration.name));
  const nextConfigurations = [...existingConfigurations];
  for (const template of templates) {
    if (!existingNames.has(template.name)) {
      nextConfigurations.push(template);
    }
  }

  const normalized = {
    version: launchConfig.version ?? '0.2.0',
    configurations: nextConfigurations
  };

  await vscode.workspace.fs.writeFile(launchJsonUri, Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8'));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(launchJsonUri));
}

export class RunMainCodeLensProvider implements vscode.CodeLensProvider {
  private readonly getBuildToolForUri: (uri: vscode.Uri) => BuildTool;
  private readonly getActiveProfile?: () => TaskProfile;

  public constructor(options: RunMainFeatureOptions) {
    this.getBuildToolForUri = options.getBuildToolForUri;
    this.getActiveProfile = options.getActiveProfile;
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!['scala', 'sbt'].includes(document.languageId) && !document.fileName.endsWith('.scala') && !document.fileName.endsWith('.sbt')) {
      return [];
    }

    const entries = detectRunEntryPoints(document.getText());
    const profile = this.getActiveProfile?.();
    const buildTool = profile?.buildTool ?? this.getBuildToolForUri(document.uri);

    return entries.flatMap((entry) => {
      const range = new vscode.Range(entry.line, 0, entry.line, 0);
      const runCodeLens = new vscode.CodeLens(range, {
        title: '▶ Run',
        command: COMMAND_RUN_MAIN_ENTRY,
        arguments: [
          {
            documentUri: document.uri.toString(),
            entryLine: entry.line
          } as RunMainArgs
        ]
      });

      const command = createRunCommand(buildTool, document, entry, profile);
      const debugCodeLens = new vscode.CodeLens(range, {
        title: '🛠 Debug',
        command: COMMAND_DEBUG_MAIN_ENTRY,
        arguments: [
          {
            documentUri: document.uri.toString(),
            entryLine: entry.line
          } as RunMainArgs
        ]
      });
      const copyCodeLens = new vscode.CodeLens(range, {
        title: 'Copy Command',
        command: COMMAND_COPY_RUN_COMMAND,
        arguments: [command ?? '']
      });

      return [runCodeLens, debugCodeLens, copyCodeLens];
    });
  }
}

async function resolveRunCommandFromFallback(document: vscode.TextDocument, entry: EntryPoint): Promise<string | undefined> {
  const packageName = inferPackageName(document.getText());
  const inferredFqn = inferFqnForEntry(packageName, entry);

  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Run with scala-cli', command: `scala-cli run "${document.uri.fsPath}"` },
      { label: 'Run with java', command: inferredFqn ? `java -cp . ${inferredFqn}` : undefined },
      { label: 'Configure build tool', command: undefined }
    ],
    {
      title: vscode.l10n.t('No build tool detected (run command fallback)')
    }
  );

  if (!picked) {
    return undefined;
  }

  if (picked.label === 'Configure build tool') {
    await vscode.commands.executeCommand('scalaLite.reDetectBuildTool');
    return undefined;
  }

  return picked.command;
}

export function registerRunMainCommands(getBuildToolForUri: (uri: vscode.Uri) => BuildTool): vscode.Disposable[] {
  return registerRunMainCommandsWithExecutor({ getBuildToolForUri }, async (command, _uri) => {
    const terminal = terminalForRun();
    terminal.sendText(command, true);
  });
}

export function registerRunMainCommandsWithExecutor(
  options: RunMainFeatureOptions,
  executeCommand: (command: string, documentUri: vscode.Uri) => Promise<void>
): vscode.Disposable[] {
  const runCommand = vscode.commands.registerCommand(COMMAND_RUN_MAIN_ENTRY, async (args: RunMainArgs) => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.documentUri));
    const entries = detectRunEntryPoints(document.getText());
    const entry = entries.find((item) => item.line === args.entryLine);
    if (!entry) {
      return;
    }

    const profile = options.getActiveProfile?.();
    const buildTool = profile?.buildTool ?? options.getBuildToolForUri(document.uri);
    let command = createRunCommand(buildTool, document, entry, profile);

    if (!command) {
      command = await resolveRunCommandFromFallback(document, entry);
    }

    if (!command) {
      return;
    }

    await executeCommand(command, document.uri);
  });

  const copyCommand = vscode.commands.registerCommand(COMMAND_COPY_RUN_COMMAND, async (command: string) => {
    if (!command) {
      vscode.window.showInformationMessage(vscode.l10n.t('No command available to copy for this entry point.'));
      return;
    }

    await vscode.env.clipboard.writeText(command);
    vscode.window.showInformationMessage(vscode.l10n.t('Run command copied to clipboard.'));
  });

  const debugCommand = vscode.commands.registerCommand(COMMAND_DEBUG_MAIN_ENTRY, async (args: RunMainArgs) => {
    if (!(await ensureJavaDebugAdapterInstalled())) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.documentUri));
    const entries = detectRunEntryPoints(document.getText());
    const entry = entries.find((item) => item.line === args.entryLine);
    if (!entry) {
      return;
    }

    const profile = options.getActiveProfile?.();
    const buildTool = profile?.buildTool ?? options.getBuildToolForUri(document.uri);
    const command = toDebugCommand(buildTool, document, entry, profile);
    if (!command) {
      return;
    }

    await executeCommand(command, document.uri);
    await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(document.uri), attachDebugConfiguration('Scala Lite: Attach Main'));
  });

  const generateDebugConfigurationCommand = vscode.commands.registerCommand(COMMAND_GENERATE_DEBUG_CONFIGURATION, async () => {
    if (!(await ensureJavaDebugAdapterInstalled())) {
      return;
    }

    await upsertLaunchJsonTemplates();
    vscode.window.showInformationMessage(vscode.l10n.t('Debug configuration generated in .vscode/launch.json.'));
  });

  return [runCommand, copyCommand, debugCommand, generateDebugConfigurationCommand];
}