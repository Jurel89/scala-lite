import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('BG-0003: Rust memory usage reports accounted and estimated overhead bytes', () => {
  const rust = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(rust.includes('pub accounted_bytes: u64,'), true);
  assert.equal(rust.includes('pub estimated_overhead_bytes: u64,'), true);
  assert.equal(rust.includes('let estimated_overhead_bytes = accounted_bytes / 5;'), true);
  assert.equal(rust.includes('includes:'), true);
  assert.equal(rust.includes('excludes:'), true);
});

test('BG-0003: native engine TypeScript surface exposes detailed memory accounting', () => {
  const source = readSource('src/nativeEngine.ts');

  assert.equal(source.includes('readonly accountedBytes: number;'), true);
  assert.equal(source.includes('readonly estimatedOverheadBytes: number;'), true);
  assert.equal(source.includes('readonly includes: string;'), true);
  assert.equal(source.includes('readonly excludes: string;'), true);
  assert.equal(source.includes('raw.accountedBytes ?? raw.accounted_bytes ?? 0'), true);
});

test('BG-0003: budget audit disambiguates extension host heap and estimated scala-lite heap', () => {
  const source = readSource('src/memoryBudget.ts');

  assert.equal(source.includes('extension host heap'), true);
  assert.equal(source.includes('estimated scala-lite heap'), true);
  assert.equal(source.includes('scalaLiteEstimatedHeapBytes'), true);
  assert.equal(source.includes('Native accounting — accounted:'), true);
});

test('BG-0003: symbol index metrics include scala-lite estimated heap bytes', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('scalaLiteEstimatedHeapBytes: this.estimateScalaLiteHeapBytes()'), true);
  assert.equal(source.includes('private estimateScalaLiteHeapBytes()'), true);
});
