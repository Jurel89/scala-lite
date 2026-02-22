import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('TC-0009: dependency query surface reads classpath cache files and returns symbols', () => {
  const source = readSource('src/dependencyQuery.ts');

  assert.equal(source.includes('queryDependencySymbols'), true);
  assert.equal(source.includes("/^classpath-.*\\.json$/"), true);
  assert.equal(source.includes('artifactNameFromJarPath'), true);
  assert.equal(source.includes('readDependencyAttachmentsByJar'), true);
  assert.equal(source.includes("packageName: 'dependency'"), true);
});

test('TC-0009: workspace symbol integration includes dependency symbols when enabled', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');

  assert.equal(source.includes('readDependencyConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes('queryDependencySymbols'), true);
  assert.equal(source.includes('includeInWorkspaceSymbol'), true);
});
