import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0020: Workspace Doctor command is contributed and registered', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.runWorkspaceDoctor');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.runWorkspaceDoctor.title%');

  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('registerWorkspaceDoctorFeature'), true);
  assert.equal(extensionSource.includes('workspaceDoctorDisposables'), true);
});

test('FR-0020: Doctor opens a webview panel and performs all required checks', () => {
  const source = readSource('src/workspaceDoctorFeature.ts');
  assert.equal(source.includes('createWebviewPanel'), true);
  assert.equal(source.includes('getPrioritizedFolderRoots'), true);
  assert.equal(source.includes('onPrioritizationApplied'), true);
  assert.equal(source.includes('orderedFolders.map'), true);
  assert.equal(source.includes("id: 'workspace-size'"), true);
  assert.equal(source.includes("id: 'scala-file-count'"), true);
  assert.equal(source.includes("id: 'target-size'"), true);
  assert.equal(source.includes("id: 'node-modules'"), true);
  assert.equal(source.includes("id: 'symlinks'"), true);
  assert.equal(source.includes("id: 'generated-sources'"), true);
  assert.equal(source.includes("id: 'scalafmt-missing'"), true);
  assert.equal(source.includes("id: 'build-tool-missing'"), true);
});

test('FR-0020: severity icons and copy report capability are implemented', () => {
  const source = readSource('src/workspaceDoctorFeature.ts');
  assert.equal(source.includes("return '🔴';"), true);
  assert.equal(source.includes("return '⚠️';"), true);
  assert.equal(source.includes("return 'ℹ️';"), true);
  assert.equal(source.includes("message.type === 'copyReport'"), true);
  assert.equal(source.includes('Workspace Doctor report copied.'), true);
});

test('FR-0020: fix actions are available for auto-remediation scenarios', () => {
  const source = readSource('src/workspaceDoctorFeature.ts');
  assert.equal(source.includes("fixAction: 'create-scalafmt'"), true);
  assert.equal(source.includes("fixAction: 'open-config'"), true);
  assert.equal(source.includes("fixAction: 'detect-build-tool'"), true);
  assert.equal(source.includes('defaultScalafmtConfContent'), true);
});

test('FR-0020: extension wires prioritized folder hints into Workspace Doctor', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('getPrioritizedFolderRoots: () => {'), true);
  assert.equal(source.includes('onPrioritizationApplied: (prioritizedFolderCount, totalFolderCount) => {'), true);
  assert.equal(source.includes('symbolIndexManager.getAllSymbols()'), true);
  assert.equal(source.includes('sort((left, right) => right[1] - left[1])'), true);
});
