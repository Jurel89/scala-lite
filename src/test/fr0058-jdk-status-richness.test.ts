import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0058: dependency JDK status command resolves JDK source/home/module counts', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes("COMMAND_DEPENDENCY_JDK_STATUS = 'scalaLite.dependencyJdkStatus'"), true);
  assert.equal(source.includes('resolveJdkModules'), true);
  assert.equal(source.includes('JDK dependency status — source: {0}, home: {1}, modules selected: {2}, modules available: {3}.'), true);
});

test('FR-0058: governor quick actions include dependency JDK status command', () => {
  const source = readSource('src/modeManager.ts');

  assert.equal(source.includes("label: vscode.l10n.t('Dependency JDK Status')"), true);
  assert.equal(source.includes("selection: 'action:dependency-jdk-status'"), true);
  assert.equal(source.includes("vscode.commands.executeCommand('scalaLite.dependencyJdkStatus')"), true);
});

test('FR-0058: governor quick actions include sync classpath command', () => {
  const source = readSource('src/modeManager.ts');

  assert.equal(source.includes("label: vscode.l10n.t('Sync Classpath')"), true);
  assert.equal(source.includes("selection: 'action:sync-classpath'"), true);
  assert.equal(source.includes("vscode.commands.executeCommand('scalaLite.syncClasspath')"), true);
});

test('FR-0058: governor quick actions include fetch dependency sources command', () => {
  const source = readSource('src/modeManager.ts');

  assert.equal(source.includes("label: vscode.l10n.t('Fetch Dependency Sources')"), true);
  assert.equal(source.includes("selection: 'action:fetch-dependency-sources'"), true);
  assert.equal(source.includes("vscode.commands.executeCommand('scalaLite.fetchDependencySources')"), true);
});
