import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0032: workspace config core tracks config source state and overlap precedence', () => {
  const source = readSource('src/workspaceConfig.ts');
  assert.equal(source.includes("export type WorkspaceConfigSource = 'defaults' | 'settings-ui' | 'json-file' | 'merged'"), true);
  assert.equal(source.includes('export async function refreshWorkspaceConfigSourceState()'), true);
  assert.equal(source.includes('hasOverlappingSettingsOverrides'), true);
});

test('FR-0032: mode manager tooltip includes config source line', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('readonly getConfigSourceLabel?: () => string;'), true);
  assert.equal(source.includes('Config: ${configSourceLabel}'), true);
});

test('FR-0032: open configuration warns when json overrides settings values', () => {
  const source = readSource('src/workspaceConfigFeature.ts');
  assert.equal(source.includes("sourceState.source === 'merged' && sourceState.hasOverlappingOverrides"), true);
  assert.equal(source.includes('Note: .vscode/scala-lite.json takes precedence over VS Code Settings for overlapping properties.'), true);
  assert.equal(source.includes("createFileSystemWatcher('**/.vscode/scala-lite.json')"), true);
});

test('FR-0032: l10n bundle includes config source labels and precedence note', () => {
  const l10n = JSON.parse(readSource('bundle.l10n.json')) as Record<string, string>;
  assert.equal(typeof l10n['settings UI'], 'string');
  assert.equal(typeof l10n['scala-lite.json'], 'string');
  assert.equal(typeof l10n['scala-lite.json + settings UI (file wins)'], 'string');
  assert.equal(typeof l10n.defaults, 'string');
  assert.equal(typeof l10n['Note: .vscode/scala-lite.json takes precedence over VS Code Settings for overlapping properties.'], 'string');
});
