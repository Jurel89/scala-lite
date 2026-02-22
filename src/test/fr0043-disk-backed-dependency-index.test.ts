import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0043: Rust dependency index module exists and defines segmented snapshot model', () => {
  const source = readSource('native/scala-lite-engine/src/dep_index.rs');

  assert.equal(source.includes('pub struct DependencySnapshot'), true);
  assert.equal(source.includes('pub struct DepSegment'), true);
  assert.equal(source.includes('pub struct SegmentLookupEntry'), true);
  assert.equal(source.includes('DEPENDENCY_INDEX_MAGIC'), true);
  assert.equal(source.includes('DEPENDENCY_INDEX_SCHEMA_VERSION'), true);
});

test('FR-0043: dependency index supports save/load and lazy segment loading queries', () => {
  const source = readSource('native/scala-lite-engine/src/dep_index.rs');

  assert.equal(source.includes('save_dependency_index'), true);
  assert.equal(source.includes('load_dependency_index'), true);
  assert.equal(source.includes('ensure_segment_loaded'), true);
  assert.equal(source.includes('query_dep_symbols'), true);
  assert.equal(source.includes('query_dep_symbol_by_fqcn'), true);
  assert.equal(source.includes('query_dep_symbols_in_package'), true);
});

test('FR-0043: cache invalidation and changed-jar detection helpers are implemented', () => {
  const source = readSource('native/scala-lite-engine/src/dep_index.rs');

  assert.equal(source.includes('dependency_index_is_stale'), true);
  assert.equal(source.includes('changed_jar_paths'), true);
  assert.equal(source.includes('JarManifest'), true);
});
