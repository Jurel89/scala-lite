import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0054: dependency artifact fetcher runs provider-specific source/javadoc commands and writes attachments', () => {
  const source = readSource('src/dependencyArtifacts.ts');

  assert.equal(source.includes("const ATTACHMENTS_FILE = 'dependency-attachments.json'"), true);
  assert.equal(source.includes('dependency:sources'), true);
  assert.equal(source.includes('-Dclassifier=javadoc'), true);
  assert.equal(source.includes('updateClassifiers'), true);
  assert.equal(source.includes('readDependencyAttachmentsByJar'), true);
});

test('FR-0054: fetch dependency command in extension uses artifact fetch implementation', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes('fetchDependencyArtifacts'), true);
  assert.equal(source.includes('Fetching dependency sources...'), true);
  assert.equal(source.includes('Dependency artifacts updated: sources {0}/{1}, javadocs {2}/{1}.'), true);
});
