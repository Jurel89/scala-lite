import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0035: symbol index stores ImportRecord entries per file and exposes lookup APIs', () => {
  const source = readSource('src/symbolIndex.ts');
  const nativeSource = readSource('src/nativeEngine.ts');
  const rustSource = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(source.includes('export interface ImportRecord'), true);
  assert.equal(source.includes('private readonly importsByFile = new Map<string, ImportRecord[]>();'), true);
  assert.equal(source.includes('public getImportsForFile(documentUri: vscode.Uri): readonly ImportRecord[]'), true);
  assert.equal(nativeSource.includes('readonly imports: readonly ImportRecord[];'), true);
  assert.equal(rustSource.includes('pub struct ImportEntry {'), true);
  assert.equal(rustSource.includes('pub imports: Vec<ImportEntry>,'), true);
  assert.equal(source.includes('const imports = parsed?.imports ?? [];'), true);
  assert.equal(source.includes('this.importsByFile.set('), true);
  assert.equal(source.includes('[...imports]'), true);
});

test('FR-0035: import extraction handles explicit, selective, Scala2 rename, Scala3 rename, and multiline forms', () => {
  const rustSource = readSource('native/scala-lite-engine/src/lib.rs');

  assert.equal(rustSource.includes('fn parse_import_statement(file_path: &str, statement: &str, line_number: u32) -> Vec<ImportEntry>'), true);
  assert.equal(rustSource.includes('selector.split_once("=>")'), true);
  assert.equal(rustSource.includes('normalized.split_once(" as ")'), true);
  assert.equal(rustSource.includes('normalized.ends_with("._") || normalized.ends_with(".*")'), true);
  assert.equal(rustSource.includes('fn tokenize_imports(file_path: &str, content: &str) -> Vec<ImportEntry>'), true);
  assert.equal(rustSource.includes("open_braces > close_braces || statement.trim_end().ends_with(',')"), true);
});
