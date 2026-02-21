import * as vscode from 'vscode';

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
}
