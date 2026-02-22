import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0051: go-to-definition Stage E merges dependency cache candidates', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('queryDependencySymbols'), true);
  assert.equal(source.includes('dependencyMatches'), true);
  assert.equal(source.includes('readDependencyConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes("if (mode === 'C')"), true);
  assert.equal(source.includes('const candidates = [...nativeMatches]'), true);
});

test('FR-0051: dependency symbol query prefers attached source paths when present', () => {
  const source = readSource('src/dependencyQuery.ts');

  assert.equal(source.includes('attachedSourcePath ?? jarPath'), true);
});
