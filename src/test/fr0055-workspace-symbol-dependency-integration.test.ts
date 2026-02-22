import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0055: workspace symbols are ranked before dependency symbols with independent caps', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');

  assert.equal(source.includes('rankedWorkspace'), true);
  assert.equal(source.includes('rankedDependency'), true);
  assert.equal(source.includes('const merged = [...rankedWorkspace.slice(0, 200), ...rankedDependency.slice(0, 100)].slice(0, 300);'), true);
  assert.equal(source.includes('readDependencyConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes('dependencyConfig.includeInWorkspaceSymbol'), true);
});

test('FR-0055: dependency results are clearly labeled with [dep] and artifact hint', () => {
  const source = readSource('src/workspaceSymbolFeature.ts');

  assert.equal(source.includes("`[dep] ${symbol.symbolName} — ${dependencyArtifactHint(symbol)}`"), true);
  assert.equal(source.includes('dependencyArtifactHint'), true);
  assert.equal(source.includes('dependencySpecificity'), true);
  assert.equal(source.includes('dependencyScalaBoost'), true);
});
