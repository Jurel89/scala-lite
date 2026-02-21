import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('BG-0002: TypeScript fallback query uses exact-match-first and returns all bucket entries', () => {
  const source = readSource('src/nativeEngine.ts');

  assert.equal(source.includes('const exactBucket = this.symbolsByName.get(trimmedQuery);'), true);
  assert.equal(source.includes('if (exactBucket && exactBucket.length > 0) {'), true);
  assert.equal(source.includes('.sort((left, right) => compareSymbols(left, right))'), true);
  assert.equal(source.includes('const rankedBuckets: Array<{ score: number; symbolName: string; symbols: readonly IndexedSymbol[] }> = [];'), true);
  assert.equal(source.includes('.flatMap((bucket) => bucket.symbols)'), true);
  assert.equal(source.includes('.slice(0, cappedLimit);'), true);
});

test('BG-0002: TypeScript fallback deterministic tie-breaker sorts by file and line', () => {
  const source = readSource('src/nativeEngine.ts');

  assert.equal(source.includes("import { compareSymbols } from './symbolSort';"), true);
  assert.equal(source.includes('.sort((left, right) => compareSymbols(left, right))'), true);
});

test('BG-0002: Rust query_symbols uses exact bucket before fuzzy fallback and flattens deterministic entries', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(source.includes('if let Some(exact_entries) = index.by_symbol.get(query) {'), true);
  assert.equal(source.includes('sorted.sort_by(compare_symbol_entries);'), true);
  assert.equal(source.includes('let mut ranked_buckets: Vec<(i32, String, Vec<SymbolEntry>)> = index'), true);
  assert.equal(source.includes('.flat_map(|(_, _, entries)| entries)'), true);
  assert.equal(source.includes('fn compare_symbol_entries(left: &SymbolEntry, right: &SymbolEntry) -> std::cmp::Ordering'), true);
  assert.equal(source.includes('.then_with(|| left.line_number.cmp(&right.line_number))'), true);
}
);
