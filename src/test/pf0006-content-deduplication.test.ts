import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0006: SymbolIndexManager no longer retains a full contentByFile cache', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('private readonly contentByFile = new Map<string, string>();'), false);
  assert.equal(source.includes('this.contentByFile.set('), false);
  assert.equal(source.includes('this.contentByFile.clear();'), false);
});

test('PF-0006: Mode C rebuild reads files via workspace.fs.readFile path', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('await this.readFileContent(fileUri);'), true);
  assert.equal(source.includes('vscode.workspace.fs.readFile(fileUri)'), true);
  assert.equal(source.includes('await vscode.workspace.openTextDocument(fileUri);'), false);
  assert.equal(source.includes('appendNativeIndexBatch(nativeBatch, token)'), true);
  assert.equal(source.includes('const files: Array<{ filePath: string; content: string }> = [];'), false);
});
