import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('IN-0005: generated N-API typings include required NativeEngine methods', () => {
  const dts = readSource('native/scala-lite-engine/index.d.ts');

  const requiredMethods = [
    'parseFile(filePath: string, content: string): ParseFileResult',
    'indexFiles(files: Array<JsFileInput>): number',
    'querySymbols(query: string, limit: number): Array<SymbolEntry>',
    'querySymbolsInPackage(query: string, packagePath: string, limit: number): Array<SymbolEntry>',
    'queryPackageExists(packagePath: string): boolean',
    'getDiagnostics(filePath: string): Array<DiagnosticEntry>',
    'evictFile(filePath: string): void',
    'rebuildIndex(files: Array<JsFileInput>): number',
    'getMemoryUsage(): JsMemoryUsage',
    'shutdown(): void'
  ];

  for (const method of requiredMethods) {
    assert.equal(dts.includes(method), true, `Missing generated typing: ${method}`);
  }
});

test('IN-0005: generated ParseFileResult and SymbolEntry typings include enriched Rust fields', () => {
  const dts = readSource('native/scala-lite-engine/index.d.ts');

  const requiredShapes = [
    'export interface ParseFileResult {',
    'filePath: string',
    'symbols: Array<SymbolEntry>',
    'imports: Array<ImportEntry>',
    'diagnostics: Array<DiagnosticEntry>',
    'export interface ImportEntry {',
    'packagePath: string',
    'isWildcard: boolean',
    'export interface SymbolEntry {',
    'packageName: string',
    'visibility: string'
  ];

  for (const shape of requiredShapes) {
    assert.equal(dts.includes(shape), true, `Missing generated typing shape: ${shape}`);
  }
});

test('IN-0005: Rust core exports corresponding query methods to avoid TS↔Rust contract drift', () => {
  const rust = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(rust.includes('pub fn query_symbols_in_package('), true);
  assert.equal(rust.includes('pub fn query_package_exists(index: &IndexSnapshot, package_path: &str) -> bool'), true);
  assert.equal(rust.includes('pub imports: Vec<ImportEntry>,'), true);
  assert.equal(rust.includes('pub package_name: String,'), true);
  assert.equal(rust.includes('pub visibility: String,'), true);
});
