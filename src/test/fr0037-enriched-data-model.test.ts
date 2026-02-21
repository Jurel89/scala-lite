import { test } from 'node:test';
import assert from 'node:assert/strict';
import './vscode-mock';
import { GoToDefinitionProvider } from '../goToDefinitionFeature';
import { SymbolIndexManager } from '../symbolIndex';
import { StructuredLogger } from '../structuredLogger';
import { WorkspaceMode } from '../modePresentation';
import { vscodeMock } from './vscode-mock';
import fs from 'node:fs';
import path from 'node:path';

test('FR-0037: Rust SymbolEntry includes package_name and visibility and populates both in tokenizer', () => {
  const rustSource = fs.readFileSync(path.resolve(process.cwd(), 'native/scala-lite-engine/src/lib.rs'), 'utf8');

  assert.ok(rustSource.includes('pub package_name: String'));
  assert.ok(rustSource.includes('pub visibility: String'));
  assert.ok(rustSource.includes('package_name: if kind == "package"'));
  assert.ok(rustSource.includes('visibility: infer_visibility(trimmed)'));
});

test('FR-0037: TypeScript model and native normalization map packageName + visibility', () => {
  const nativeEngineSource = fs.readFileSync(path.resolve(process.cwd(), 'src/nativeEngine.ts'), 'utf8');

  assert.ok(nativeEngineSource.includes('readonly packageName?: string;'));
  assert.ok(nativeEngineSource.includes('readonly package_name?: string;'));
  assert.ok(nativeEngineSource.includes('const packageName = typeof raw.packageName === \'string\''));
  assert.ok(nativeEngineSource.includes('const visibility = raw.visibility === \'public\''));
  assert.ok(nativeEngineSource.includes('packageName,'));
  assert.ok(nativeEngineSource.includes('visibility,'));
});

test('FR-0037: Go-to-definition package boost uses packageName instead of containerName', async () => {
  let queriedPackageName = '';
  
  const mockIndexManager = {
    searchSymbols: async () => [],
    querySymbolsInPackage: async (symbolName: string, packageName: string) => {
      queriedPackageName = packageName;
      return [
        { symbolName: 'TargetSymbol', filePath: '/workspace/src/File1.scala', lineNumber: 10, symbolKind: 'class', visibility: 'public', packageName: 'com.example' }
      ];
    },
    querySymbolsByExactName: async () => [],
    getImportsForFile: () => [],
    getSymbolsForFile: () => []
  } as unknown as SymbolIndexManager;

  const logger = new StructuredLogger('INFO');
  const provider = new GoToDefinitionProvider(mockIndexManager, () => 'C' as WorkspaceMode, logger);

  const document = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    fileName: '/workspace/src/Main.scala',
    getText: () => 'TargetSymbol',
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(5, 0), new vscodeMock.Position(5, 12)),
    lineAt: (line: number) => {
      if (line === 0) return { text: 'package com.example' };
      return { text: '  val x = new TargetSymbol()' };
    },
    lineCount: 10
  } as any;

  const position = new vscodeMock.Position(5, 5) as any;
  const token = new vscodeMock.CancellationTokenSource().token as any;

  await provider.provideDefinition(document, position, token);
  
  assert.equal(queriedPackageName, 'com.example');
});

