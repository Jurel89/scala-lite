import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('IN-0003: symbol index manager syncs native index and exposes native query path', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes('public async searchSymbols('), true);
  assert.equal(source.includes('getNativeEngine().querySymbols'), true);
  assert.equal(source.includes('await this.getNativeEngine().rebuildIndex(files, token);'), true);
  assert.equal(source.includes('await this.getNativeEngine().evictFile(filePath);'), true);
});

test('IN-0003: workspace symbol provider uses symbol index native search for non-empty queries', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');
  assert.equal(source.includes('await this.symbolIndexManager.searchSymbols(normalizedQuery, 300, token);'), true);
  assert.equal(source.includes('public async provideWorkspaceSymbols('), true);
});

test('IN-0003: go-to-definition text-search tier prioritizes files from native-backed symbol hits', () => {
  const source = readSource('src/goToDefinitionFeature.ts');
  assert.equal(source.includes('private async prioritizeTextSearchFiles('), true);
  assert.equal(source.includes('await this.symbolIndexManager.searchSymbols(symbolName, 400, token)'), true);
  assert.equal(source.includes('for (const fileUri of prioritizedFileUris)'), true);
});

test('IN-0003: find usages provider preselects candidates from native-backed symbol hits', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('private async prioritizeCandidateFiles('), true);
  assert.equal(source.includes('this.symbolIndexManager.searchSymbols(symbol, 400, token)'), true);
  assert.equal(source.includes('match.symbolName === symbol'), true);
});

test('IN-0003: extension wires syntax diagnostics controller and mode-triggered refresh', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('new SyntaxDiagnosticsController(symbolIndexManager, () => activeMode, logger)'), true);
  assert.equal(source.includes('await syntaxDiagnosticsController.refreshOpenDocuments();'), true);
  assert.equal(source.includes('void syntaxDiagnosticsController.refreshOpenDocuments();'), true);
});

test('IN-0003: syntax diagnostics controller reads diagnostics from SymbolIndexManager', () => {
  const source = readSource('src/syntaxDiagnosticsFeature.ts');
  assert.equal(source.includes('class SyntaxDiagnosticsController'), true);
  assert.equal(source.includes('getDiagnosticsForDocument(document, token)'), true);
  assert.equal(source.includes("createDiagnosticCollection('scala-lite-syntax')"), true);
  assert.equal(source.includes("diagnostic.source = 'Scala Lite (syntax)'"), true);
});

test('IN-0003: symbol index search guards against malformed symbol records', () => {
  const source = readSource('src/symbolIndex.ts');
  assert.equal(source.includes('isValidIndexedSymbol'), true);
  assert.equal(source.includes('symbols.filter((symbol) => isValidIndexedSymbol(symbol))'), true);
  assert.equal(source.includes('if (!isValidIndexedSymbol(symbol))'), true);
});
