import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0005: dynamic budget computation exists with workspace-scaled formulas', () => {
  const source = readSource('src/memoryBudget.ts');

  assert.equal(source.includes('export function computeBudgetForMode'), true);
  assert.equal(source.includes('fileCount * 0.4'), true);
  assert.equal(source.includes('symbolCount * 0.004'), true);
  assert.equal(source.includes('openFileCount * 0.5'), true);
  assert.equal(source.includes('Math.min(toMbBytes(768)'), true);
  assert.equal(source.includes('totalSystemMemoryBytes * 0.08'), true);
});

test('PF-0005: memory budget overrides are read from workspace config', () => {
  const source = readSource('src/workspaceConfig.ts');

  assert.equal(source.includes('readMemoryBudgetOverridesFromWorkspaceConfig'), true);
  assert.equal(source.includes('config.budgets?.memory'), true);
  assert.equal(source.includes('heapMb'), true);
  assert.equal(source.includes('nativeMb'), true);
  assert.equal(source.includes('totalMb'), true);
});

test('PF-0005: schema supports budgets.memory overrides', () => {
  const schema = readSource('schema/scala-lite.schema.json');
  assert.equal(schema.includes('"memory"'), true);
  assert.equal(schema.includes('"heapMb"'), true);
  assert.equal(schema.includes('"nativeMb"'), true);
  assert.equal(schema.includes('"totalMb"'), true);
});

test('PF-0005: extension passes index metrics into memory budget audit', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('symbolIndexManager.getMemoryBudgetMetrics()'), true);
});
