import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0033: shared badge formatter defines indexed/text badge output', () => {
  const source = readSource('src/resultBadges.ts');
  assert.equal(source.includes("export type ResultSource = 'indexed' | 'text'"), true);
  assert.equal(source.includes("return '[Indexed]'"), true);
  assert.equal(source.includes("return '≈ [Text]'"), true);
});

test('FR-0033: go-to-definition emits indexed/text status badges', () => {
  const source = readSource('src/goToDefinitionFeature.ts');
  assert.equal(source.includes('formatResultBadge'), true);
  assert.equal(source.includes("formatResultBadge('indexed')"), true);
  assert.equal(source.includes("formatResultBadge('text')"), true);
});

test('FR-0033: find usages applies mode-aware source badges in status context', () => {
  const source = readSource('src/findUsagesFeature.ts');
  assert.equal(source.includes('resolveResultSource(mode, selectedScope)'), true);
  assert.equal(source.includes('formatResultBadge'), true);
  assert.equal(source.includes('Textual references for {0} (scope: {1})'), true);
});

test('FR-0033: workspace symbol labels include indexed/text badge prefixes', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');
  assert.equal(source.includes('resolveSymbolSource'), true);
  assert.equal(source.includes('formatResultBadge(source)'), true);
  assert.equal(source.includes('`${badge} ${modulePrefix}: ${symbol.symbolName}`'), true);
  assert.equal(source.includes('`${badge} ${symbol.symbolName}`'), true);
});
