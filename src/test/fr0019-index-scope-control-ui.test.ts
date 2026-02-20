import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0019: status bar shows compact governor summary', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('SL: [Index:'), true);
  assert.equal(source.includes('[Diag:'), true);
  assert.equal(source.includes('[Build:'), true);
});

test('FR-0019: clicking status bar opens governor quick pick with sections', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('Scala Lite Control Governor'), true);
  assert.equal(source.includes('vscode.QuickPickItemKind.Separator'), true);
  assert.equal(source.includes("label: vscode.l10n.t('Index')"), true);
  assert.equal(source.includes("label: vscode.l10n.t('Diagnostics')"), true);
  assert.equal(source.includes("label: vscode.l10n.t('Build Integration')"), true);
});

test('FR-0019: index governor options map to mode transitions', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes("selection === 'index:off'"), true);
  assert.equal(source.includes("await this.switchMode('A', true)"), true);
  assert.equal(source.includes("selection === 'index:open-files'"), true);
  assert.equal(source.includes("await this.switchMode('B', true)"), true);
  assert.equal(source.includes("selection === 'index:module'"), true);
  assert.equal(source.includes("await this.switchMode('C', true)"), true);
});

test('FR-0019: scope increases require explicit confirmation', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('confirmScopeIncrease'), true);
  assert.equal(source.includes('Increasing index scope may increase CPU and memory usage. Continue?'), true);
  assert.equal(source.includes("vscode.l10n.t('Continue')"), true);
  assert.equal(source.includes("vscode.l10n.t('Cancel')"), true);
});

test('FR-0019: build integration state is toggleable and wired to extension', () => {
  const modeSource = readSource('src/modeManager.ts');
  const extensionSource = readSource('src/extension.ts');

  assert.equal(modeSource.includes('onBuildIntegrationChanged'), true);
  assert.equal(modeSource.includes('BUILD_INTEGRATION_STORAGE_KEY'), true);
  assert.equal(extensionSource.includes('buildIntegrationEnabled = enabled;'), true);
});
