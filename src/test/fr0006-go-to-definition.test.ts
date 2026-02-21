import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { vscodeMock } from './vscode-mock';
import { GoToDefinitionProvider } from '../goToDefinitionFeature';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0006: mode manager supports injected definition provider', () => {
  const source = readSource('src/modeManager.ts');
  assert.equal(source.includes('readonly definitionProvider?: vscode.DefinitionProvider;'), true);
  assert.equal(source.includes('this.options.definitionProvider.provideDefinition'), true);
});

test('FR-0006: GoToDefinitionProvider resolves exact match in same file (Stage B)', async () => {
  const mockSymbolIndexManager = {
    getSymbolsForFile: (uri: any) => {
      if (uri.fsPath === '/workspace/src/Main.scala') {
        return [{
          symbolName: 'myTargetSymbol',
          symbolKind: 'def',
          filePath: '/workspace/src/Main.scala',
          lineNumber: 42,
          containerName: 'Main',
          packageName: 'com.example',
          visibility: 'public'
        }];
      }
      return [];
    },
    getImportsForFile: () => [],
    querySymbolsInPackage: async () => [],
    searchSymbols: async () => []
  } as any;

  const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
  const provider = new GoToDefinitionProvider(mockSymbolIndexManager, () => 'C' as any, mockLogger);

  const mockDocument = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    fileName: '/workspace/src/Main.scala',
    lineCount: 100,
    lineAt: (line: number) => ({ text: line === 0 ? 'package com.example' : '' }),
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(10, 5), new vscodeMock.Position(10, 19)),
    getText: () => 'myTargetSymbol'
  } as any;

  const mockPosition = new vscodeMock.Position(10, 10) as any;
  const mockToken = new vscodeMock.CancellationTokenSource().token as any;

  const result = await provider.provideDefinition(mockDocument, mockPosition, mockToken) as any;

  assert.ok(result, 'Expected a definition result');
  assert.equal(Array.isArray(result) ? result.length : 1, 1, 'Expected exactly one location');
  
  const location = Array.isArray(result) ? result[0] : result;
  assert.equal(location.uri.fsPath, '/workspace/src/Main.scala');
  assert.equal(location.range.start.line, 41);
});

test('FR-0006: GoToDefinitionProvider falls back to text search (Stage F) when no symbols found', async () => {
  let searchSymbolsCalled = false;
  let searchLimit = 0;

  const mockSymbolIndexManager = {
    getSymbolsForFile: () => [],
    getImportsForFile: () => [],
    querySymbolsInPackage: async () => [],
    searchSymbols: async (query: string, limit: number) => {
      searchSymbolsCalled = true;
      searchLimit = limit;
      return [];
    }
  } as any;

  const mockLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
  const provider = new GoToDefinitionProvider(mockSymbolIndexManager, () => 'C' as any, mockLogger);

  const mockDocument = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    fileName: '/workspace/src/Main.scala',
    lineCount: 100,
    lineAt: (line: number) => ({ text: line === 0 ? 'package com.example' : '' }),
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(10, 5), new vscodeMock.Position(10, 19)),
    getText: () => 'unknownSymbol'
  } as any;

  const mockPosition = new vscodeMock.Position(10, 10) as any;
  const mockToken = new vscodeMock.CancellationTokenSource().token as any;

  (vscodeMock.workspace as any).findFiles = async () => [];

  const result = await provider.provideDefinition(mockDocument, mockPosition, mockToken);

  assert.equal(searchSymbolsCalled, true, 'Expected searchSymbols to be called for Stage E/F fallback');
  assert.equal(searchLimit, 300, 'Expected search limit to be 300 as per TRD');
  assert.deepEqual(result, [], 'Expected empty result when text search also fails');
});

test('FR-0006: extension wires go-to-definition provider with active mode context', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('new GoToDefinitionProvider(symbolIndexManager, () => activeMode, logger)'), true);
  assert.equal(source.includes('activeMode = mode;'), true);
  assert.equal(source.includes('definitionProvider'), true);
});
