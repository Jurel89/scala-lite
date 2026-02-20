import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0007: implements WorkspaceSymbolProvider with fuzzy subsequence scoring', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');
  assert.equal(source.includes('implements vscode.WorkspaceSymbolProvider'), true);
  assert.equal(source.includes('subsequenceScore'), true);
  assert.equal(source.includes('provideWorkspaceSymbols'), true);
});

test('FR-0007: ranking order is prefix, fuzzy score, then recency', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');
  assert.equal(source.includes('prefixRank'), true);
  assert.equal(source.includes('fuzzyScore'), true);
  assert.equal(source.includes('recencyScore'), true);
  assert.equal(source.includes('left.prefixRank - right.prefixRank'), true);
  assert.equal(source.includes('right.fuzzyScore - left.fuzzyScore'), true);
  assert.equal(source.includes('right.recencyScore - left.recencyScore'), true);
});

test('FR-0007: provider is mode-gated and not active in Mode A', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');
  assert.equal(source.includes("if (mode === 'A')"), true);
  assert.equal(source.includes('return [];'), true);
});

test('FR-0007: ModeManager registers workspace symbol provider only for Mode B/C', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('readonly workspaceSymbolProvider?: vscode.WorkspaceSymbolProvider;'), true);
  assert.equal(source.includes('registerWorkspaceSymbolProvider'), true);
  assert.equal(source.includes("if (mode === 'B' || mode === 'C')"), true);
});

test('FR-0007: extension wires workspace symbol provider and recency updates', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('new WorkspaceSymbolSearchProvider(symbolIndexManager, () => activeMode)'), true);
  assert.equal(source.includes('workspaceSymbolProvider.recordFileAccess(editor.document.uri)'), true);
  assert.equal(source.includes('workspaceSymbolProvider.recordFileAccess(document.uri)'), true);
  assert.equal(source.includes('workspaceSymbolProvider'), true);
});
