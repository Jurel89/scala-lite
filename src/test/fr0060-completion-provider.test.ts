import { test } from 'node:test';
import assert from 'node:assert/strict';
import './vscode-mock';
import { ScalaCompletionProvider } from '../completionFeature';
import { SymbolIndexManager } from '../symbolIndex';
import { StructuredLogger } from '../structuredLogger';
import { WorkspaceMode } from '../modePresentation';
import { vscodeMock } from './vscode-mock';

function buildProvider(
  mode: WorkspaceMode,
  searchResults: Array<{ symbolName: string; symbolKind: string; filePath: string; lineNumber: number; packageName: string; visibility: string }>
): ScalaCompletionProvider {
  const mockIndexManager = {
    searchSymbols: async () => searchResults
  } as unknown as SymbolIndexManager;

  return new ScalaCompletionProvider(
    mockIndexManager,
    () => mode,
    new StructuredLogger('INFO')
  );
}

function mockDocument(wordAtPosition: string | undefined) {
  return {
    getWordRangeAtPosition: () =>
      wordAtPosition
        ? new vscodeMock.Range(
            new vscodeMock.Position(0, 0),
            new vscodeMock.Position(0, wordAtPosition.length)
          )
        : undefined,
    getText: () => wordAtPosition ?? ''
  } as any;
}

function mockToken(cancelled = false) {
  return { isCancellationRequested: cancelled } as any;
}

function mockPosition() {
  return new vscodeMock.Position(0, 3) as any;
}

test('FR-0060: completion provider returns empty in Mode A', async () => {
  const provider = buildProvider('A', [
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken());
  assert.equal(items.length, 0);
});

test('FR-0060: completion provider returns empty in Mode B', async () => {
  const provider = buildProvider('B', [
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken());
  assert.equal(items.length, 0);
});

test('FR-0060: completion provider returns results in Mode C', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'FooBar', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' },
    { symbolName: 'FooBaz', symbolKind: 'def', filePath: '/b.scala', lineNumber: 5, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken());
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'FooBar');
  assert.equal(items[1].label, 'FooBaz');
});

test('FR-0060: completion provider requires minimum 2-character prefix', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('F'), mockPosition(), mockToken());
  assert.equal(items.length, 0);
});

test('FR-0060: completion provider returns empty when no word at position', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument(undefined), mockPosition(), mockToken());
  assert.equal(items.length, 0);
});

test('FR-0060: completion provider deduplicates by name:kind', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' },
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/b.scala', lineNumber: 10, packageName: 'com.other', visibility: 'public' },
    { symbolName: 'Foo', symbolKind: 'def', filePath: '/c.scala', lineNumber: 3, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken());
  // Two distinct name:kind combos: Foo:class and Foo:def
  assert.equal(items.length, 2);
});

test('FR-0060: completion provider filters out package symbols', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'com.example', symbolKind: 'package', filePath: '/a.scala', lineNumber: 1, packageName: '', visibility: 'public' },
    { symbolName: 'FooClass', symbolKind: 'class', filePath: '/a.scala', lineNumber: 5, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken());
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'FooClass');
});

test('FR-0060: completion provider returns empty when cancelled', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'Foo', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken(true));
  assert.equal(items.length, 0);
});

test('FR-0060: completion provider sets detail with package qualification', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'MyClass', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: 'com.example', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('MyClass'), mockPosition(), mockToken());
  assert.equal(items.length, 1);
  assert.equal(items[0].detail, 'com.example.MyClass');
});

test('FR-0060: completion provider gives prefix matches higher sort priority', async () => {
  const provider = buildProvider('C', [
    { symbolName: 'FooBar', symbolKind: 'class', filePath: '/a.scala', lineNumber: 1, packageName: '', visibility: 'public' },
    { symbolName: 'BarFoo', symbolKind: 'class', filePath: '/b.scala', lineNumber: 1, packageName: '', visibility: 'public' }
  ]);
  const items = await provider.provideCompletionItems(mockDocument('Foo'), mockPosition(), mockToken());
  const fooBar = items.find((i: any) => i.label === 'FooBar');
  const barFoo = items.find((i: any) => i.label === 'BarFoo');
  assert.ok(fooBar);
  assert.ok(barFoo);
  // Prefix match gets sortText starting with "0", non-prefix gets "1"
  assert.ok(fooBar!.sortText! < barFoo!.sortText!);
});
