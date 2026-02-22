import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0015: dependency artifacts include dedicated sources-cache index and size cap', () => {
  const source = readSource('src/dependencyArtifacts.ts');

  assert.equal(source.includes("const SOURCES_CACHE_DIR = 'sources-cache'"), true);
  assert.equal(source.includes("const SOURCES_CACHE_INDEX_FILE = 'sources-cache-index.json'"), true);
  assert.equal(source.includes('DEFAULT_MAX_SOURCES_CACHE_BYTES'), true);
  assert.equal(source.includes('readSourcesCacheIndex'), true);
  assert.equal(source.includes('writeSourcesCacheIndex'), true);
});

test('PF-0015: sources cache enforces LRU eviction and emits structured WARN logs', () => {
  const source = readSource('src/dependencyArtifacts.ts');

  assert.equal(source.includes('enforceSourcesCacheLru'), true);
  assert.equal(source.includes('toEpochMillis(left.lastAccessedAt) - toEpochMillis(right.lastAccessedAt)'), true);
  assert.equal(source.includes("level: 'WARN'"), true);
  assert.equal(source.includes("category: 'CONFIG'"), true);
  assert.equal(source.includes('sources-cache LRU evicted'), true);
});

test('PF-0015: fetch/read paths update cache usage timestamps for source artifacts', () => {
  const source = readSource('src/dependencyArtifacts.ts');

  assert.equal(source.includes('cacheAttachmentArtifact(options.workspaceFolder, sourcesPathCandidate)'), true);
  assert.equal(source.includes('cacheAttachmentArtifact(options.workspaceFolder, javadocPathCandidate)'), true);
  assert.equal(source.includes('touchSourcesCacheEntry(workspaceFolder, entry.sourcesPath)'), true);
  assert.equal(source.includes('touchSourcesCacheEntry(workspaceFolder, entry.javadocPath)'), true);
});
