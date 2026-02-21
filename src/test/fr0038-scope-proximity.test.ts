import { test } from 'node:test';
import assert from 'node:assert/strict';
import './vscode-mock';
import { GoToDefinitionProvider } from '../goToDefinitionFeature';
import { SymbolIndexManager } from '../symbolIndex';
import { StructuredLogger } from '../structuredLogger';
import { WorkspaceMode } from '../modePresentation';
import { vscodeMock } from './vscode-mock';

test('FR-0038: same-file definition uses scope-proximity candidates instead of first-match find', async () => {
  // Arrange a document with multiple same-name defs at different indentation levels.
  const lines = new Map<number, string>([
    [0, 'package com.example'],
    [4, 'def target(): Unit = {}'],
    [11, '  def target(): Unit = {}'],
    [20, '    val x = target']
  ]);

  const document = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    fileName: '/workspace/src/Main.scala',
    getText: () => 'target',
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(20, 10), new vscodeMock.Position(20, 16)),
    lineAt: (line: number) => ({ text: lines.get(line) ?? '' }),
    lineCount: 25
  } as any;

  // Symbol index entries mirror the above defs (lineNumber is 1-based in symbols).
  const mockIndexManager = {
    getSymbolsForFile: () => [
      { symbolName: 'target', filePath: '/workspace/src/Main.scala', lineNumber: 5, symbolKind: 'def', visibility: 'public', packageName: 'com.example' },
      { symbolName: 'target', filePath: '/workspace/src/Main.scala', lineNumber: 12, symbolKind: 'def', visibility: 'public', packageName: 'com.example' }
    ],
    searchSymbols: async () => [],
    querySymbolsInPackage: async () => [],
    querySymbolsByExactName: async () => [],
    getImportsForFile: () => [],
    packageExists: async () => false
  } as unknown as SymbolIndexManager;

  const logger = new StructuredLogger('INFO');
  const provider = new GoToDefinitionProvider(mockIndexManager, () => 'C' as WorkspaceMode, logger);

  const position = new vscodeMock.Position(20, 10) as any;
  const token = new vscodeMock.CancellationTokenSource().token as any;

  // Act: run full pipeline; expect Stage B to pick the closer, same-indent candidate (line 12).
  const result = await provider.provideDefinition(document, position, token);

  assert.ok(!Array.isArray(result));
  assert.equal((result as any).uri.fsPath, '/workspace/src/Main.scala');
  assert.equal((result as any).range.start.line, 11); // zero-based -> lineNumber 12
});
