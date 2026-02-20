import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('IN-0001: rust crate exists at native/scala-lite-engine', () => {
  const cargoTomlPath = path.resolve(process.cwd(), 'native/scala-lite-engine/Cargo.toml');
  const libPath = path.resolve(process.cwd(), 'native/scala-lite-engine/src/lib.rs');

  assert.equal(fs.existsSync(cargoTomlPath), true);
  assert.equal(fs.existsSync(libPath), true);
});

test('IN-0001: crate exposes required public API functions', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');
  assert.equal(source.includes('pub fn parse_file('), true);
  assert.equal(source.includes('pub fn index_files('), true);
  assert.equal(source.includes('pub fn query_symbols('), true);
  assert.equal(source.includes('pub fn get_diagnostics('), true);
  assert.equal(source.includes('pub fn get_memory_usage('), true);
});

test('IN-0001: implementation uses rayon and avoids unsafe blocks', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');
  assert.equal(source.includes('rayon::prelude::*'), true);
  assert.equal(source.includes('.par_iter()'), true);
  assert.equal(source.includes('unsafe {'), false);
});

test('IN-0001: public API returns Result<T, E> via custom EngineError', () => {
  const source = readSource('native/scala-lite-engine/src/lib.rs');
  assert.equal(source.includes('pub enum EngineError'), true);
  assert.equal(source.includes('-> Result<ParseFileResult, EngineError>'), true);
  assert.equal(source.includes('-> Result<IndexSnapshot, EngineError>'), true);
  assert.equal(source.includes('-> Result<Vec<SymbolEntry>, EngineError>'), true);
  assert.equal(source.includes('-> Result<Vec<DiagnosticEntry>, EngineError>'), true);
  assert.equal(source.includes('-> Result<MemoryUsage, EngineError>'), true);
});
