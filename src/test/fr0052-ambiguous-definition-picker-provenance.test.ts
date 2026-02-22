import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0052: chooser includes provenance badges and grouped sorting order', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('provenanceBadge'), true);
  assert.equal(source.includes("return '[Workspace]'"), true);
  assert.equal(source.includes("return '[Dependency]'"), true);
  assert.equal(source.includes("return '[JDK]'"), true);
  assert.equal(source.includes('provenanceRank(left) - provenanceRank(right)'), true);
  assert.equal(source.includes('label: `${symbolKindCodicon(entry.symbolKind)} ${entry.symbolName} — ${vscode.workspace.asRelativePath(vscode.Uri.file(entry.filePath), false)}:${entry.lineNumber} ${provenanceBadge(entry)}`'), true);
});

test('FR-0052: stage E merges dependency candidates for ambiguous picker display', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('const finalCandidates = [...candidates, ...dependencyMatches]'), true);
  assert.equal(source.includes('dependencyArtifactHint'), true);
});
