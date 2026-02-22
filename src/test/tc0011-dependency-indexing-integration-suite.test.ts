import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('TC-0011: classpath sync orchestrator integration persists sync + JDK state', () => {
  const source = readSource('src/dependencySyncOrchestrator.ts');

  assert.equal(source.includes("const SYNC_STATUS_FILE = 'dependency-sync-status.json'"), true);
  assert.equal(source.includes("const JDK_STATE_FILE = 'jdk-modules.json'"), true);
  assert.equal(source.includes('syncMavenClasspathWithJdk'), true);
  assert.equal(source.includes('syncSbtClasspathWithJdk'), true);
  assert.equal(source.includes('writeDependencySyncFailure'), true);
});

test('TC-0011: dependency navigation fallback integrates go-to-definition with dependency query', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('queryDependencySymbols'), true);
  assert.equal(source.includes('dependencyMatches'), true);
  assert.equal(source.includes("function provenanceKey(symbol: IndexedSymbol): 'workspace' | 'dependency' | 'jdk'"), true);
  assert.equal(source.includes("return '[Workspace]'"), true);
  assert.equal(source.includes("return '[Dependency]'"), true);
  assert.equal(source.includes("return '[JDK]'"), true);
});

test('TC-0011: source-vs-signature behavior is integrated across hover and attachments', () => {
  const hoverSource = readSource('src/hoverInfoFeature.ts');
  const artifactSource = readSource('src/dependencyArtifacts.ts');

  assert.equal(hoverSource.includes('Sources available — Cmd+click to navigate.'), true);
  assert.equal(hoverSource.includes('No sources available —'), true);
  assert.equal(hoverSource.includes("commandLink('scalaLite.fetchDependencySources')"), true);
  assert.equal(artifactSource.includes("const ATTACHMENTS_FILE = 'dependency-attachments.json'"), true);
  assert.equal(artifactSource.includes('readDependencyAttachmentsByJar'), true);
});
