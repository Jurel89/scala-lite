import * as vscode from 'vscode';
import * as path from 'node:path';

const EXTENSION_ID = 'jurel89.scala-lite';
const ACTIVATION_TIMEOUT_MS = 10_000;

function timeoutAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Activation timed out after ${ms}ms for extension '${EXTENSION_ID}'.`));
    }, ms);
  });
}

async function assertRequiredCommandsRegistered(): Promise<void> {
  const requiredCommands = [
    'scalaLite.pickWorkspaceMode',
    'scalaLite.openConfiguration',
    'scalaLite.runWorkspaceDoctor'
  ];

  const allCommands = await vscode.commands.getCommands(true);
  const missingCommands = requiredCommands.filter((command) => !allCommands.includes(command));

  if (missingCommands.length > 0) {
    throw new Error(`Missing registered command(s): ${missingCommands.join(', ')}.`);
  }
}

async function assertGoToDefinitionProviderAvailable(fixtureWorkspacePath: string): Promise<void> {
  const uri = vscode.Uri.file(path.join(fixtureWorkspacePath, 'Main.scala'));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document);

  const position = new vscode.Position(1, 6); // inside main identifier
  const results = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', document.uri, position);

  if (!Array.isArray(results)) {
    throw new Error('Definition provider did not return an array result.');
  }
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {
    throw new Error(`Extension '${EXTENSION_ID}' is not installed in the test host.`);
  }

  await Promise.race([
    extension.activate(),
    timeoutAfter(ACTIVATION_TIMEOUT_MS)
  ]);

  if (!extension.isActive) {
    throw new Error(`Extension '${EXTENSION_ID}' did not become active after activation call.`);
  }

  await assertRequiredCommandsRegistered();
  await assertGoToDefinitionProviderAvailable(path.resolve(extension.extensionPath, 'src', 'test', 'fixtures', 'smoke-workspace'));
}
