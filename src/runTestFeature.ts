import * as vscode from 'vscode';
import { BuildTool } from './buildToolInference';
import {
  applyProfileCommandShape,
  renderTemplate,
  TaskProfile
} from './profileCore';
import {
  createIndividualTestCommand,
  createSuiteTestCommand,
  detectTestCases,
  detectTestSuites,
  supportsIndividualTargeting,
  TestFramework,
  TestSuiteMatch
} from './runTestLogic';

export const COMMAND_RUN_TEST_SUITE = 'scalaLite.runTestSuite';
export const COMMAND_RUN_TEST_CASE = 'scalaLite.runTestCase';
export const COMMAND_COPY_TEST_COMMAND = 'scalaLite.copyTestCommand';

const TEST_TERMINAL_NAME = 'Scala Lite: Test';

interface RunSuiteArgs {
  readonly documentUri: string;
  readonly suiteLine: number;
}

interface RunTestArgs {
  readonly documentUri: string;
  readonly suiteLine: number;
  readonly testLine: number;
}

interface RunTestFeatureOptions {
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

function findSuiteByLine(suites: readonly TestSuiteMatch[], line: number): TestSuiteMatch | undefined {
  return suites.find((suite) => suite.line === line);
}

function suiteForTestLine(suites: readonly TestSuiteMatch[], line: number): TestSuiteMatch | undefined {
  const sorted = [...suites].sort((a, b) => a.line - b.line);
  let candidate: TestSuiteMatch | undefined;

  for (const suite of sorted) {
    if (suite.line <= line) {
      candidate = suite;
      continue;
    }

    break;
  }

  return candidate;
}

function terminalForTest(): vscode.Terminal {
  const existing = vscode.window.terminals.find((terminal) => terminal.name === TEST_TERMINAL_NAME);
  if (existing) {
    existing.show(true);
    return existing;
  }

  const terminal = vscode.window.createTerminal({ name: TEST_TERMINAL_NAME });
  terminal.show(true);
  return terminal;
}

function unsupportedLabel(framework: TestFramework): string {
  return `▶ Run Suite (individual test not supported for ${framework})`;
}

export class RunTestCodeLensProvider implements vscode.CodeLensProvider {
  private readonly getBuildToolForUri: (uri: vscode.Uri) => BuildTool;
  private readonly getActiveProfile?: () => TaskProfile;

  public constructor(options: RunTestFeatureOptions) {
    this.getBuildToolForUri = options.getBuildToolForUri;
    this.getActiveProfile = options.getActiveProfile;
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!document.fileName.endsWith('.scala')) {
      return [];
    }

    const text = document.getText();
    const suites = detectTestSuites(text);
    const profile = this.getActiveProfile?.();
    const buildTool = profile?.buildTool ?? this.getBuildToolForUri(document.uri);
    const millModule = inferMillModule(document);

    const lenses: vscode.CodeLens[] = [];

    for (const suite of suites) {
      const suiteRange = new vscode.Range(suite.line, 0, suite.line, 0);
      const rawSuiteCommand = createSuiteTestCommand(buildTool, document.uri.fsPath, suite.suiteName, text, millModule);
      const suiteCommand = profile
        ? applyProfileCommandShape(
            renderTemplate(profile.testCommand || rawSuiteCommand, {
              suiteName: suite.suiteName,
              filePath: document.uri.fsPath,
              jvmOpts: profile.jvmOpts.join(' ')
            }).trim(),
            profile
          )
        : rawSuiteCommand;

      lenses.push(
        new vscode.CodeLens(suiteRange, {
          title: '▶ Run Suite',
          command: COMMAND_RUN_TEST_SUITE,
          arguments: [
            {
              documentUri: document.uri.toString(),
              suiteLine: suite.line
            } as RunSuiteArgs
          ]
        })
      );

      lenses.push(
        new vscode.CodeLens(suiteRange, {
          title: 'Copy Command',
          command: COMMAND_COPY_TEST_COMMAND,
          arguments: [suiteCommand]
        })
      );

      const cases = detectTestCases(text, suite.framework);
      const individualSupported = supportsIndividualTargeting(suite.framework);

      if (!individualSupported) {
        lenses.push(
          new vscode.CodeLens(suiteRange, {
            title: unsupportedLabel(suite.framework),
            command: COMMAND_RUN_TEST_SUITE,
            arguments: [
              {
                documentUri: document.uri.toString(),
                suiteLine: suite.line
              } as RunSuiteArgs
            ]
          })
        );
        continue;
      }

      for (const testCase of cases) {
        const testRange = new vscode.Range(testCase.line, 0, testCase.line, 0);
        const rawTestCommand = createIndividualTestCommand(
          buildTool,
          suite.framework,
          document.uri.fsPath,
          suite.suiteName,
          testCase.testName,
          text,
          millModule
        );
        const testCommand = rawTestCommand && profile
          ? applyProfileCommandShape(
              renderTemplate(rawTestCommand, {
                suiteName: suite.suiteName,
                testName: testCase.testName,
                filePath: document.uri.fsPath,
                jvmOpts: profile.jvmOpts.join(' ')
              }).trim(),
              profile
            )
          : rawTestCommand;

        lenses.push(
          new vscode.CodeLens(testRange, {
            title: '▶ Run Test',
            command: COMMAND_RUN_TEST_CASE,
            arguments: [
              {
                documentUri: document.uri.toString(),
                suiteLine: suite.line,
                testLine: testCase.line
              } as RunTestArgs
            ]
          })
        );

        lenses.push(
          new vscode.CodeLens(testRange, {
            title: 'Copy Command',
            command: COMMAND_COPY_TEST_COMMAND,
            arguments: [testCommand ?? suiteCommand]
          })
        );
      }
    }

    return lenses;
  }
}

export function registerRunTestCommands(getBuildToolForUri: (uri: vscode.Uri) => BuildTool): vscode.Disposable[] {
  return registerRunTestCommandsWithExecutor({ getBuildToolForUri }, async (command) => {
    const terminal = terminalForTest();
    terminal.sendText(command, true);
  });
}

export function registerRunTestCommandsWithExecutor(
  options: RunTestFeatureOptions,
  executeCommand: (command: string, documentUri: vscode.Uri) => Promise<void>
): vscode.Disposable[] {
  const runSuiteCommand = vscode.commands.registerCommand(COMMAND_RUN_TEST_SUITE, async (args: RunSuiteArgs) => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.documentUri));
    const text = document.getText();
    const suites = detectTestSuites(text);
    const suite = findSuiteByLine(suites, args.suiteLine);
    if (!suite) {
      return;
    }

    const profile = options.getActiveProfile?.();
    const buildTool = profile?.buildTool ?? options.getBuildToolForUri(document.uri);
    const rawCommand = createSuiteTestCommand(buildTool, document.uri.fsPath, suite.suiteName, text, inferMillModule(document));
    const command = profile
      ? applyProfileCommandShape(
          renderTemplate(profile.testCommand || rawCommand, {
            suiteName: suite.suiteName,
            filePath: document.uri.fsPath,
            jvmOpts: profile.jvmOpts.join(' ')
          }).trim(),
          profile
        )
      : rawCommand;
    await executeCommand(command, document.uri);
  });

  const runTestCaseCommand = vscode.commands.registerCommand(COMMAND_RUN_TEST_CASE, async (args: RunTestArgs) => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.documentUri));
    const text = document.getText();
    const suites = detectTestSuites(text);
    const suite = findSuiteByLine(suites, args.suiteLine) ?? suiteForTestLine(suites, args.testLine);
    if (!suite) {
      return;
    }

    const testCase = detectTestCases(text, suite.framework).find((item) => item.line === args.testLine);
    if (!testCase) {
      return;
    }

    const profile = options.getActiveProfile?.();
    const buildTool = profile?.buildTool ?? options.getBuildToolForUri(document.uri);
    const millModule = inferMillModule(document);
    const rawSuiteCommand = createSuiteTestCommand(buildTool, document.uri.fsPath, suite.suiteName, text, millModule);
    const rawCommand =
      createIndividualTestCommand(
        buildTool,
        suite.framework,
        document.uri.fsPath,
        suite.suiteName,
        testCase.testName,
        text,
        millModule
      ) ?? rawSuiteCommand;

    const command = profile
      ? applyProfileCommandShape(
          renderTemplate(rawCommand, {
            suiteName: suite.suiteName,
            testName: testCase.testName,
            filePath: document.uri.fsPath,
            jvmOpts: profile.jvmOpts.join(' ')
          }).trim(),
          profile
        )
      : rawCommand;

    await executeCommand(command, document.uri);
  });

  const copyTestCommand = vscode.commands.registerCommand(COMMAND_COPY_TEST_COMMAND, async (command: string) => {
    if (!command) {
      vscode.window.showInformationMessage(vscode.l10n.t('No test command available to copy.'));
      return;
    }

    await vscode.env.clipboard.writeText(command);
    vscode.window.showInformationMessage(vscode.l10n.t('Test command copied to clipboard.'));
  });

  return [runSuiteCommand, runTestCaseCommand, copyTestCommand];
}