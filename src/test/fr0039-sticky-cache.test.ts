import { test } from 'node:test';
import assert from 'node:assert/strict';
import './vscode-mock';
import { GoToDefinitionProvider } from '../goToDefinitionFeature';
import { SymbolIndexManager } from '../symbolIndex';
import { StructuredLogger } from '../structuredLogger';
import { WorkspaceMode } from '../modePresentation';
import { vscodeMock } from './vscode-mock';

function originSnapshot(tokenText: string) {
  return {
    originDocumentUri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    originFilePath: '/workspace/src/Main.scala',
    originPackageName: 'com.example',
    originLine: 10,
    originColumn: 4,
    tokenText
  };
}

function buildProvider(overrides: Partial<SymbolIndexManager> = {}): GoToDefinitionProvider {
  const mockIndexManager = {
    getSymbolsForFile: () => [],
    searchSymbols: async () => [],
    querySymbolsInPackage: async () => [],
    querySymbolsByExactName: async () => [],
    getImportsForFile: () => [],
    packageExists: async () => false,
    ...overrides
  } as unknown as SymbolIndexManager;

  return new GoToDefinitionProvider(mockIndexManager, () => 'C' as WorkspaceMode, new StructuredLogger('INFO'));
}

test('FR-0039: sticky cache hit returns cached location when still valid', async () => {
  const provider = buildProvider({
    getSymbolsForFile: () => [
      { symbolName: 'Foo', filePath: '/workspace/src/File.scala', lineNumber: 30, symbolKind: 'def', visibility: 'public', packageName: 'com.example' }
    ]
  });

  const snapshot = originSnapshot('Foo');
  (provider as any).recordStickyChoice(snapshot, {
    symbolName: 'Foo', symbolKind: 'def', filePath: '/workspace/src/File.scala', lineNumber: 30, visibility: 'public', packageName: 'com.example'
  });

  const token = new vscodeMock.CancellationTokenSource().token as any;
  const resolution = await (provider as any).resolveFromStickyCache(snapshot, token);

  assert.ok(resolution);
  assert.equal(resolution?.location.uri.fsPath, '/workspace/src/File.scala');
  assert.equal(resolution?.location.range.start.line, 29);
});

test('FR-0039: stale cached entry is evicted when target no longer valid', async () => {
  const provider = buildProvider({
    getSymbolsForFile: () => [],
    searchSymbols: async () => []
  });

  const snapshot = originSnapshot('Bar');
  (provider as any).recordStickyChoice(snapshot, {
    symbolName: 'Bar', symbolKind: 'def', filePath: '/workspace/src/Old.scala', lineNumber: 40, visibility: 'public', packageName: 'com.example'
  });

  const token = new vscodeMock.CancellationTokenSource().token as any;
  const resolution = await (provider as any).resolveFromStickyCache(snapshot, token);

  assert.equal(resolution, undefined);
  const cacheSize = (provider as any).stickyChoiceCache.size;
  assert.equal(cacheSize, 0);
});

test('FR-0039: bypass configuration disables sticky cache usage', async () => {
  vscodeMock.workspace.__config['scalaLite.goToDefinition.stickyCache.bypass'] = true;

  try {
    const provider = buildProvider({
      getSymbolsForFile: () => [
        { symbolName: 'Baz', filePath: '/workspace/src/File.scala', lineNumber: 25, symbolKind: 'def', visibility: 'public', packageName: 'com.example' }
      ]
    });

    const snapshot = originSnapshot('Baz');
    (provider as any).recordStickyChoice(snapshot, {
      symbolName: 'Baz', symbolKind: 'def', filePath: '/workspace/src/File.scala', lineNumber: 25, visibility: 'public', packageName: 'com.example'
    });

    const token = new vscodeMock.CancellationTokenSource().token as any;
    const resolution = await (provider as any).resolveFromStickyCache(snapshot, token);

    assert.equal(resolution, undefined);
  } finally {
    delete vscodeMock.workspace.__config['scalaLite.goToDefinition.stickyCache.bypass'];
  }
});
