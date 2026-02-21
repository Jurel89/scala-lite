import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0022: Go-to-Definition shows exact/likely/text-search confidence badges', () => {
  const source = readSource('src/goToDefinitionFeature.ts');
  assert.equal(source.includes("this.showBadge(vscode.l10n.t('Exact'))"), true);
  assert.equal(source.includes("this.showBadge(vscode.l10n.t('📍 Likely'))"), true);
  assert.equal(source.includes("this.showBadge(vscode.l10n.t('🔍 Text Search'))"), true);
});

test('FR-0022: Find Usages header always includes scope and textual method labeling', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('Textual references for {0} (scope: {1})'), true);
});

test('FR-0022: Workspace symbol results include module prefix in Mode C', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');
  assert.equal(source.includes("const modulePrefix = mode === 'C'"), true);
  assert.equal(source.includes('resolveModulePrefix'), true);
  assert.equal(source.includes('modulePrefix ?'), true);
  assert.equal(source.includes('`${badge} ${modulePrefix}: ${symbol.symbolName}`'), true);
});

test('FR-0022: honesty labels are localized in bundle', () => {
  const l10n = JSON.parse(readSource('bundle.l10n.json')) as Record<string, string>;
  assert.equal(typeof l10n.Exact, 'string');
  assert.equal(typeof l10n['📍 Likely'], 'string');
  assert.equal(typeof l10n['🔍 Text Search'], 'string');
});
