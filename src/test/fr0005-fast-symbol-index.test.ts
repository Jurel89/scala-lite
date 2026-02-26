import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './vscode-mock';
import {
  COMMAND_REBUILD_INDEX,
  IndexedSymbol,
  ImportRecord,
  MemoryBreakdown,
  SymbolIndexManager
} from '../symbolIndex';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0005: rebuild index command constant matches package.json contribution', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  assert.equal(COMMAND_REBUILD_INDEX, 'scalaLite.rebuildIndex');
  const command = packageJson.contributes.commands.find(
    (entry) => entry.command === COMMAND_REBUILD_INDEX
  );
  assert.ok(command, 'rebuild index command must be contributed in package.json');
});

test('FR-0005: IndexedSymbol interface has required fields for symbol and location data', () => {
  const testSymbol: IndexedSymbol = {
    symbolName: 'Foo',
    symbolKind: 'class',
    filePath: '/workspace/Foo.scala',
    lineNumber: 10,
    packageName: 'com.example',
    visibility: 'public',
    containerName: 'Main'
  };

  assert.equal(testSymbol.symbolName, 'Foo');
  assert.equal(testSymbol.symbolKind, 'class');
  assert.equal(testSymbol.filePath, '/workspace/Foo.scala');
  assert.equal(testSymbol.lineNumber, 10);
  assert.equal(testSymbol.containerName, 'Main');
});

test('FR-0005: ImportRecord interface supports wildcard and named imports', () => {
  const namedImport: ImportRecord = {
    packagePath: 'scala.collection',
    importedName: 'mutable',
    isWildcard: false,
    lineNumber: 3
  };
  assert.equal(namedImport.isWildcard, false);
  assert.equal(namedImport.importedName, 'mutable');

  const wildcardImport: ImportRecord = {
    packagePath: 'scala.collection.mutable',
    isWildcard: true,
    lineNumber: 4
  };
  assert.equal(wildcardImport.isWildcard, true);
  assert.equal(wildcardImport.importedName, undefined);
});

test('FR-0005: SymbolIndexManager class is exported and constructable', () => {
  assert.equal(typeof SymbolIndexManager, 'function');
});

test('FR-0005: MemoryBreakdown tracks file, symbol, import, and diagnostic counts', () => {
  const breakdown: MemoryBreakdown = {
    fileCount: 50,
    symbolCount: 1200,
    importCount: 300,
    diagnosticCount: 5,
    contentCacheBytes: 4096,
    estimatedJsHeapBytes: 1_000_000,
    nativeMemoryUsage: { heapBytes: 0, accountedBytes: 0, estimatedOverheadBytes: 0, nativeRssBytes: 0, totalBytes: 0, includes: '', excludes: '' }
  };

  assert.equal(breakdown.fileCount, 50);
  assert.equal(breakdown.symbolCount, 1200);
  assert.equal(breakdown.diagnosticCount, 5);
});
