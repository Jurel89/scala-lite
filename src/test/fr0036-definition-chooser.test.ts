import { test } from 'node:test';
import assert from 'node:assert/strict';
import './vscode-mock';
import { GoToDefinitionProvider } from '../goToDefinitionFeature';
import { SymbolIndexManager } from '../symbolIndex';
import { StructuredLogger } from '../structuredLogger';
import { WorkspaceMode } from '../modePresentation';
import { vscodeMock } from './vscode-mock';

test('FR-0036: chooser labels include kind icon, symbol, location, and stage reason badge', async () => {
  const mockIndexManager = {
    searchSymbols: async () => [],
    querySymbolsInPackage: async () => [
      { symbolName: 'AmbiguousSymbol', filePath: '/workspace/src/File1.scala', lineNumber: 10, symbolKind: 'class', visibility: 'public', packageName: 'com.example' },
      { symbolName: 'AmbiguousSymbol', filePath: '/workspace/src/File2.scala', lineNumber: 20, symbolKind: 'object', visibility: 'private', packageName: 'com.example' }
    ],
    querySymbolsByExactName: async () => [],
    getImportsForFile: () => [
      { importedName: 'AmbiguousSymbol', isWildcard: false, line: 2, isRenamed: false, originalName: 'AmbiguousSymbol', packagePath: 'com.example' }
    ],
    getSymbolsForFile: () => []
  } as unknown as SymbolIndexManager;

  const logger = new StructuredLogger('INFO');
  const provider = new GoToDefinitionProvider(mockIndexManager, () => 'C' as WorkspaceMode, logger);

  const document = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    fileName: '/workspace/src/Main.scala',
    getText: () => 'AmbiguousSymbol',
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(5, 0), new vscodeMock.Position(5, 15)),
    lineAt: () => ({ text: '  val x = new AmbiguousSymbol()' }),
    lineCount: 10
  } as any;

  const originalShowQuickPick = vscodeMock.window.showQuickPick;
  let capturedItems: any[] = [];
  vscodeMock.window.showQuickPick = async (items: any[]) => {
    capturedItems = items;
    return items[0];
  };

  try {
    const position = new vscodeMock.Position(5, 5) as any;
    const token = new vscodeMock.CancellationTokenSource().token as any;
    await provider.provideDefinition(document, position, token);
  } finally {
    vscodeMock.window.showQuickPick = originalShowQuickPick;
  }

  assert.equal(capturedItems.length, 2);
  assert.ok(capturedItems[0].label.includes('$(symbol-class) AmbiguousSymbol'));
  assert.ok(capturedItems[0].label.includes('src/File1.scala:10'));
  assert.equal(capturedItems[0].description, 'com.example');
  assert.ok(capturedItems[0].detail.includes('[imported] class • public'));
  assert.ok(capturedItems[1].detail.includes('private'));
});

test('FR-0036: Stage C ambiguity routes directly to chooser (no D/E narrowing)', async () => {
  const mockIndexManager = {
    searchSymbols: async () => [],
    querySymbolsInPackage: async () => [
      { symbolName: 'AmbiguousSymbol', filePath: '/workspace/src/File1.scala', lineNumber: 10, symbolKind: 'class', visibility: 'public', packageName: 'com.example' },
      { symbolName: 'AmbiguousSymbol', filePath: '/workspace/src/File2.scala', lineNumber: 20, symbolKind: 'object', visibility: 'public', packageName: 'com.example' }
    ],
    querySymbolsByExactName: async () => [],
    getImportsForFile: () => [
      { importedName: 'AmbiguousSymbol', isWildcard: false, line: 2, isRenamed: false, originalName: 'AmbiguousSymbol', packagePath: 'com.example' }
    ],
    getSymbolsForFile: () => []
  } as unknown as SymbolIndexManager;

  const logger = new StructuredLogger('INFO');
  const provider = new GoToDefinitionProvider(mockIndexManager, () => 'C' as WorkspaceMode, logger);

  const document = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    fileName: '/workspace/src/Main.scala',
    getText: () => 'AmbiguousSymbol',
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(5, 0), new vscodeMock.Position(5, 15)),
    lineAt: () => ({ text: '  val x = new AmbiguousSymbol()' }),
    lineCount: 10
  } as any;

  const position = new vscodeMock.Position(5, 5) as any;
  const token = new vscodeMock.CancellationTokenSource().token as any;

  // The provider should return an array of locations for ambiguous results
  const result = await provider.provideDefinition(document, position, token);
  
  // Since we mocked showQuickPick to return items[0], it will return a single location
  assert.ok(!Array.isArray(result));
  assert.equal((result as any).uri.fsPath, '/workspace/src/File1.scala');
});
