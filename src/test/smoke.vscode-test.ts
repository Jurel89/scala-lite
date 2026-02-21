import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'smoke', 'extensionHost.js');
  const fixtureWorkspacePath = path.resolve(__dirname, 'fixtures', 'smoke-workspace');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [fixtureWorkspacePath, '--disable-extensions']
  });
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Smoke test bootstrap failed: ${message}`);
  process.exit(1);
});
