import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0008: implements ReferenceProvider with scoped quick pick', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('implements vscode.ReferenceProvider'), true);
  assert.equal(source.includes('Find Usages Scope'), true);
  assert.equal(source.includes('Current File'), true);
  assert.equal(source.includes('Current Folder'), true);
  assert.equal(source.includes('Current Module'), true);
  assert.equal(source.includes('Entire Workspace'), true);
});

test('FR-0008: workspace scope requires explicit warning confirmation', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('Searching all workspace files may be slow for large repos. Continue?'), true);
  assert.equal(source.includes('Search'), true);
  assert.equal(source.includes('Narrow Scope'), true);
  assert.equal(source.includes('Cancel'), true);
});

test('FR-0008: default scope follows Mode A/B/C policy', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes("if (mode === 'A')"), true);
  assert.equal(source.includes("return 'current-file';"), true);
  assert.equal(source.includes("if (mode === 'B')"), true);
  assert.equal(source.includes("return 'current-folder';"), true);
  assert.equal(source.includes("return 'current-module';"), true);
});

test('FR-0008: search respects ignore rules and file guards', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('resolveWorkspaceIgnoreRules'), true);
  assert.equal(source.includes('new Minimatch'), true);
  assert.equal(source.includes('prioritizeCandidateFiles'), true);
  assert.equal(source.includes('this.symbolIndexManager.searchSymbols(symbol, 400, token)'), true);
  assert.equal(source.includes("extension === '.class'"), true);
  assert.equal(source.includes('MAX_FILE_SIZE_BYTES'), true);
});

test('FR-0008: budget cutoff returns partial results with show-all action', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('readBudgetConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes('Search stopped at budget limit. Found {0} references.'), true);
  assert.equal(source.includes('Show All — may take longer'), true);
});

test('FR-0008: provider is wired through ModeManager and extension activation', () => {
  const modeManagerSource = readSource('src/modeManager.ts');
  const extensionSource = readSource('src/extension.ts');
  assert.equal(modeManagerSource.includes('readonly referenceProvider?: vscode.ReferenceProvider;'), true);
  assert.equal(modeManagerSource.includes('registerReferenceProvider'), true);
  assert.equal(extensionSource.includes('new FindUsagesProvider(symbolIndexManager, () => activeMode)'), true);
  assert.equal(extensionSource.includes('referenceProvider'), true);
});

test('FR-0008: localization bundle includes new find-usages strings', () => {
  const l10n = JSON.parse(readSource('bundle.l10n.json')) as Record<string, string>;
  assert.equal(typeof l10n['Find Usages Scope'], 'string');
  assert.equal(typeof l10n['Searching all workspace files may be slow for large repos. Continue?'], 'string');
  assert.equal(typeof l10n['Textual references for {0} (scope: {1})'], 'string');
  assert.equal(typeof l10n['Show All — may take longer'], 'string');
});
