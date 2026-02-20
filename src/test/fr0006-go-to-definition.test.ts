import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0006: mode manager supports injected definition provider', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('readonly definitionProvider?: vscode.DefinitionProvider;'), true);
  assert.equal(source.includes('this.options.definitionProvider.provideDefinition'), true);
});

test('FR-0006: go-to-definition includes tier badges and fallback search UX', () => {
  const source = readSource('src/goToDefinitionFeature.ts');
  assert.equal(source.includes('Exact'), true);
  assert.equal(source.includes('📍 Likely'), true);
  assert.equal(source.includes('🔍 Text Search'), true);
  assert.equal(source.includes('await this.symbolIndexManager.searchSymbols(symbolName, 200, token)'), true);
  assert.equal(source.includes('private async prioritizeTextSearchFiles('), true);
  assert.equal(source.includes('await this.symbolIndexManager.searchSymbols(symbolName, 400, token)'), true);
  assert.equal(source.includes('for (const fileUri of prioritizedFileUris)'), true);
  assert.equal(source.includes('private async findIndexedDefinition('), true);
  assert.equal(source.includes('Open Find in Files'), true);
  assert.equal(source.includes('Select definition for {0}'), true);
});

test('FR-0006: extension wires go-to-definition provider with active mode context', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('new GoToDefinitionProvider(symbolIndexManager, () => activeMode, logger)'), true);
  assert.equal(source.includes('activeMode = mode;'), true);
  assert.equal(source.includes('definitionProvider'), true);
});
