import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0004: document symbol provider extracts Scala structural declarations', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('function extractDocumentSymbols(document: vscode.TextDocument)'), true);
  assert.equal(source.includes('case\\s+class|sealed\\s+trait|class|object|trait|enum|def|val|var|type|given'), true);
  assert.equal(source.includes('registerDocumentSymbolProvider'), true);
});

test('FR-0004: outline provider groups imports under a dedicated symbol node', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes("new vscode.DocumentSymbol(\n      'imports'"), true);
  assert.equal(source.includes('importGroup.children.push(...imports);'), true);
});

test('FR-0004: provider registration is available across all modes', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('const documentSymbolProvider = vscode.languages.registerDocumentSymbolProvider(selector,'), true);
  assert.equal(source.includes("if (mode === 'B' || mode === 'C')"), true);
});
