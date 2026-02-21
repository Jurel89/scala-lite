import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getModeText } from '../modePresentation';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0002: mode label for A is correct', () => {
  assert.equal(getModeText('A'), '⚡ A');
});

test('FR-0002: mode label for B is correct', () => {
  assert.equal(getModeText('B'), '▶ B');
});

test('FR-0002: mode label for C is correct', () => {
  assert.equal(getModeText('C'), '🔍 C');
});

test('FR-0002: status bar item is created with right alignment and priority 100', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)'), true);
});

test('FR-0002: command palette commands for switching modes are registered', () => {
  const packageJson = readSource('package.json');
  assert.equal(packageJson.includes('"scalaLite.switchModeA"'), true);
  assert.equal(packageJson.includes('"scalaLite.switchModeB"'), true);
  assert.equal(packageJson.includes('"scalaLite.switchModeC"'), true);
});

test('FR-0002: mode state is persisted in workspace storage', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('workspaceState.update(MODE_STORAGE_KEY, targetMode)'), true);
});

test('FR-0002: mode C persists selected module folder to scala-lite.json', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('writeIndexedModuleFolderToWorkspaceConfig('), true);
});

test('FR-0002: initial mode fallback defaults to Mode C when nothing is stored', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes("const initialMode = storedMode ?? configuredDefaultMode ?? 'C';"), true);
});

test('FR-0002: providers are only registered for non-Mode-A states', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes("if (mode === 'B' || mode === 'C')"), true);
  assert.equal(source.includes('registerDocumentSymbolProvider'), true);
  assert.equal(source.includes('registerCodeLensProvider'), true);
  assert.equal(source.includes('registerDefinitionProvider'), true);
});
