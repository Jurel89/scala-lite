import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0011: JsStringTable utility supports interning and savings stats', () => {
  const source = readSource('src/jsStringTable.ts');

  assert.equal(source.includes('export class JsStringTable'), true);
  assert.equal(source.includes('intern(value: string): string'), true);
  assert.equal(source.includes('estimatedByteSavings'), true);
  assert.equal(source.includes('entryCount'), true);
  assert.equal(source.includes('clear(): void'), true);
});

test('PF-0011: SymbolIndexManager interns filePath/packageName/containerName fields', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('private readonly stringTable = new JsStringTable();'), true);
  assert.equal(source.includes('filePath: this.stringTable.intern(symbol.filePath)'), true);
  assert.equal(source.includes('packageName: this.stringTable.intern(symbol.packageName)'), true);
  assert.equal(source.includes('containerName: symbol.containerName ? this.stringTable.intern(symbol.containerName) : undefined'), true);
});

test('PF-0011: string table is cleared on rebuild/dispose and reported in memory breakdown', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('this.stringTable.clear();'), true);
  assert.equal(source.includes('stringTableEntries: this.stringTable.getStats().entryCount'), true);
  assert.equal(source.includes('stringTableBytes: this.stringTable.getStats().estimatedByteSavings'), true);
});
