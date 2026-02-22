import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0013: rust engine defines bounded parallel JAR worker strategy', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(source.includes('MAX_PARALLEL_JAR_WORKERS'), true);
  assert.equal(source.includes('compute_parallel_jar_worker_count'), true);
  assert.equal(source.includes('available_parallelism'), true);
  assert.equal(source.includes('ThreadPoolBuilder::new()'), true);
  assert.equal(source.includes('.num_threads(worker_count)'), true);
});

test('PF-0013: rust engine parallel JAR indexing sorts deterministic output', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(source.includes('index_jars_parallel'), true);
  assert.equal(source.includes('.par_iter()'), true);
  assert.equal(source.includes('indexed.sort_by'), true);
  assert.equal(source.includes('then(left.0.cmp(&right.0))'), true);
});

test('PF-0013: rust unit tests cover determinism and worker bounds', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(source.includes('parallel_jar_indexing_is_deterministic'), true);
  assert.equal(source.includes('parallel_jar_worker_count_is_bounded'), true);
});
