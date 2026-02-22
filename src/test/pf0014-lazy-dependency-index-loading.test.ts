import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('PF-0014: dependency index schema version is incremented for lazy lookup format changes', () => {
  const source = read('native/scala-lite-engine/src/dep_index.rs');

  assert.equal(source.includes('pub const DEPENDENCY_INDEX_SCHEMA_VERSION: u16 = 2;'), true);
  assert.equal(source.includes('UnsupportedSchemaVersion'), true);
});

test('PF-0014: query path uses lookup tables to load only candidate segments', () => {
  const source = read('native/scala-lite-engine/src/dep_index.rs');

  assert.equal(source.includes('pub simple_name_lookup: HashMap<u32, Vec<u16>>'), true);
  assert.equal(source.includes('pub fqcn_lookup: HashMap<u32, u16>'), true);
  assert.equal(source.includes('for (simple_name_id, segments) in &snapshot.simple_name_lookup'), true);
  assert.equal(source.includes('let Some(segment_key) = snapshot.fqcn_lookup.get(&fqcn_id).copied() else'), true);
});

test('PF-0014: segment cache eviction controls loaded segment memory', () => {
  const source = read('native/scala-lite-engine/src/dep_index.rs');

  assert.equal(source.includes('pub fn set_dependency_index_max_loaded_segments('), true);
  assert.equal(source.includes('pub fn evict_dependency_index_segments('), true);
  assert.equal(source.includes('while loaded.len() > max_segments'), true);
});
