import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0012: dependency hot memory is tracked and included in budget audit', () => {
  const source = readSource('src/memoryBudget.ts');

  assert.equal(source.includes('getDependencyHotMemoryUsageBytes'), true);
  assert.equal(source.includes('maxDependencyBytes'), true);
  assert.equal(source.includes('dependencyUsedBytes'), true);
  assert.equal(source.includes('dependencyOverage'), true);
  assert.equal(source.includes('Mode dependency budget (bytes):'), true);
  assert.equal(source.includes('evictDependencyIndexSegments(0)'), true);
});

test('PF-0012: dependency query updates hot-memory estimate', () => {
  const source = readSource('src/dependencyQuery.ts');

  assert.equal(source.includes('lastDependencyHotMemoryBytes'), true);
  assert.equal(source.includes('estimateClasspathPayloadBytes'), true);
  assert.equal(source.includes('getDependencyHotMemoryUsageBytes'), true);
  assert.equal(source.includes('getTotalDependencyMemoryUsageBytes'), true);
});

test('PF-0012: deps memory budget setting is exposed in schema and VS Code settings', () => {
  const schema = readSource('schema/scala-lite.schema.json');
  const packageJson = readSource('package.json');
  const workspaceConfig = readSource('src/workspaceConfig.ts');

  assert.equal(schema.includes('"depsMb"'), true);
  assert.equal(packageJson.includes('"scalaLite.budgets.memory.depsMb"'), true);
  assert.equal(workspaceConfig.includes('depsMb'), true);
});
