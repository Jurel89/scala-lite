import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('TC-0012: scala-lite cache utilities expose dependency cache detection and snapshot GC', () => {
  const source = readSource('src/scalaLiteCache.ts');

  assert.equal(source.includes('DEFAULT_MAX_SNAPSHOTS_PER_KEY = 3'), true);
  assert.equal(source.includes('DEFAULT_MAX_CACHE_BYTES = 200 * 1024 * 1024'), true);
  assert.equal(source.includes('export async function hasDependencyIndexCache'), true);
  assert.equal(source.includes('export async function pruneScalaLiteCacheSnapshots'), true);
  assert.equal(source.includes('deleteCacheEntryWithRetry'), true);
  assert.equal(source.includes('Scala Lite cache GC evicted'), true);
});

test('TC-0012: classpath index writers trigger cache GC after snapshot writes', () => {
  const mavenSource = readSource('src/mavenProvider.ts');
  const sbtSource = readSource('src/sbtProvider.ts');

  assert.equal(mavenSource.includes('pruneScalaLiteCacheSnapshots(workspaceFolder)'), true);
  assert.equal(sbtSource.includes('pruneScalaLiteCacheSnapshots(workspaceFolder)'), true);
});
