import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'smoke', 'extensionHost.js');
  const fixtureWorkspacePath = path.resolve(__dirname, 'fixtures', 'smoke-workspace');

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [fixtureWorkspacePath, '--disable-extensions']
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Smoke test bootstrap failed: ${message}`);
  }
}

void main();
