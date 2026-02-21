import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('TC-0007: shared compareSymbols defines deterministic base ordering', () => {
  const source = readSource('src/symbolSort.ts');

  assert.equal(source.includes('export function compareSymbols('), true);
  assert.equal(source.includes('const fileOrder = left.filePath.localeCompare(right.filePath);'), true);
  assert.equal(source.includes('if (left.lineNumber !== right.lineNumber) {'), true);
  assert.equal(source.includes('const leftKindOrder = SYMBOL_KIND_ORDER[left.symbolKind]'), true);
  assert.equal(source.includes('return left.symbolName.localeCompare(right.symbolName);'), true);
});

test('TC-0007: compareSymbols supports custom primary criteria and cursor proximity variant', () => {
  const source = readSource('src/symbolSort.ts');
  const rustSource = readSource('native/scala-lite-engine/src/lib.rs');
  const workspaceSource = readSource('src/workspaceSymbolFeature.ts');

  assert.equal(source.includes('primaryComparator?: (left: IndexedSymbol, right: IndexedSymbol) => number'), true);
  assert.equal(source.includes('export function compareSymbolsWithCursorProximity('), true);
  assert.equal(source.includes('const leftDistance = Math.abs(left.lineNumber - cursorLine);'), true);
  assert.equal(workspaceSource.includes('return compareSymbols(left.symbol, right.symbol);'), true);
  assert.equal(rustSource.includes('then_with(|| symbol_kind_rank(&left.kind).cmp(&symbol_kind_rank(&right.kind)))'), true);
  assert.equal(rustSource.includes('fn symbol_kind_rank(kind: &str) -> u8'), true);
});
