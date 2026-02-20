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

const RUN_TERMINAL_NAME = 'Scala Lite: Run';

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
      const copyCodeLens = new vscode.CodeLens(range, {
        title: 'Copy Command',
        command: COMMAND_COPY_RUN_COMMAND,
        arguments: [command ?? '']
      });

      return [runCodeLens, copyCodeLens];
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

  return [runCommand, copyCommand];
}