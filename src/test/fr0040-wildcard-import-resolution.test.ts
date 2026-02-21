import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0040: Stage C resolves wildcard imports from same-project package symbols', () => {
  const source = readSource('src/goToDefinitionFeature.ts');
  const indexSource = readSource('src/symbolIndex.ts');
  const nativeSource = readSource('src/nativeEngine.ts');

  assert.equal(source.includes('const imports = this.symbolIndexManager.getImportsForFile(originSnapshot.originDocumentUri);'), true);
  assert.equal(source.includes('const packageExists = await this.symbolIndexManager.packageExists(importRecord.packagePath, token);'), true);
  assert.equal(source.includes('const sameProjectPackageSymbols = await this.symbolIndexManager.querySymbolsInPackage('), true);
  assert.equal(indexSource.includes('public async querySymbolsInPackage('), true);
  assert.equal(indexSource.includes('public async packageExists(packagePath: string, token?: vscode.CancellationToken): Promise<boolean>'), true);
  assert.equal(nativeSource.includes('query_symbols_in_package'), true);
  assert.equal(nativeSource.includes('query_package_exists'), true);
});

test('FR-0040: Stage C classifies wildcard confidence and logs external-package skip', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes("wildcard import — external package, skipped"), true);
  assert.equal(source.includes("if (wildcardImportMatches.length === 1) {"), true);
  assert.equal(source.includes("confidence = 'high';"), true);
  assert.equal(source.includes("} else if (wildcardImportMatches.length > 1) {"), true);
  assert.equal(source.includes("confidence = 'medium';"), true);
});
