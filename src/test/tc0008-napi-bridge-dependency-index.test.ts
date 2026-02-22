import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('TC-0008: Rust NAPI bridge exposes dependency index build/load/query/stats/memory APIs', () => {
  const rust = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(rust.includes('pub fn index_dependency_jars('), true);
  assert.equal(rust.includes('pub fn load_dependency_index('), true);
  assert.equal(rust.includes('pub fn query_dependency_symbols('), true);
  assert.equal(rust.includes('pub fn query_dependency_symbol_by_fqcn('), true);
  assert.equal(rust.includes('pub fn query_dependency_symbols_in_package('), true);
  assert.equal(rust.includes('pub fn get_dependency_index_stats('), true);
  assert.equal(rust.includes('pub fn get_dependency_memory_usage('), true);
});

test('TC-0008: TypeScript native bridge wires dependency index APIs with fallback-safe behavior', () => {
  const bridge = readSource('src/nativeEngine.ts');

  assert.equal(bridge.includes('public async indexDependencyJars('), true);
  assert.equal(bridge.includes('public async loadDependencyIndex('), true);
  assert.equal(bridge.includes('public async queryDependencySymbols('), true);
  assert.equal(bridge.includes('public async getDependencyIndexStats('), true);
  assert.equal(bridge.includes('public async getDependencyMemoryUsage('), true);
  assert.equal(bridge.includes('Dependency indexing API unavailable in native addon.'), true);
});

test('TC-0008: generated native typings include dependency index methods and DTOs', () => {
  const dts = readSource('native/scala-lite-engine/index.d.ts');

  assert.equal(dts.includes('indexDependencyJars(jarPaths: Array<string>, outputPath: string'), true);
  assert.equal(dts.includes('loadDependencyIndex(path: string): number'), true);
  assert.equal(dts.includes('queryDependencySymbols(handle: number, name: string, limit: number): Array<JsDependencySymbol>'), true);
  assert.equal(dts.includes('getDependencyIndexStats(handle: number): JsDepIndexStats'), true);
  assert.equal(dts.includes('getDependencyMemoryUsage(handle: number): JsDepMemoryUsage'), true);
  assert.equal(dts.includes('export interface JsDependencySymbol {'), true);
});
