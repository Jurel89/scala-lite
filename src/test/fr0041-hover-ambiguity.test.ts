import { test } from 'node:test';
import assert from 'node:assert/strict';
import './vscode-mock';
import { HoverInfoProvider } from '../hoverInfoFeature';
import { GoToDefinitionProvider } from '../goToDefinitionFeature';
import { StructuredLogger } from '../structuredLogger';
import { WorkspaceMode } from '../modePresentation';
import { vscodeMock } from './vscode-mock';

function buildHoverProvider(resolver: Pick<GoToDefinitionProvider, 'resolveDefinitionCandidates'>): HoverInfoProvider {
  return new HoverInfoProvider(resolver, () => 'C' as WorkspaceMode, new StructuredLogger('INFO'));
}

test('FR-0041: ambiguous hover shows deterministic top-5 summary and F12 action', async () => {
  vscodeMock.workspace.__documents['/workspace/src/A.scala'] = ['def Foo(): Unit = {}'];
  vscodeMock.workspace.__documents['/workspace/src/B.scala'] = ['def Foo(): Unit = {}'];

  const resolver = {
    resolveDefinitionCandidates: async () => ({
      kind: 'multiple' as const,
      symbolName: 'Foo',
      candidates: [
        { symbolName: 'Foo', filePath: '/workspace/src/A.scala', lineNumber: 1, symbolKind: 'def', visibility: 'public', packageName: 'com.example' },
        { symbolName: 'Foo', filePath: '/workspace/src/B.scala', lineNumber: 1, symbolKind: 'def', visibility: 'public', packageName: 'com.example' }
      ],
      confidence: 'medium',
      stage: 'C',
      reason: 'stage-C-ambiguous'
    })
  } as Pick<GoToDefinitionProvider, 'resolveDefinitionCandidates'>;

  const provider = buildHoverProvider(resolver);

  const document = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(2, 4), new vscodeMock.Position(2, 7)),
    getText: () => 'Foo'
  } as any;

  const token = new vscodeMock.CancellationTokenSource().token as any;
  const hover = await provider.provideHover(document, new vscodeMock.Position(2, 5) as any, token);

  assert.ok(hover);
  const markdown = (hover as any).contents[0];
  const value = markdown.value as string;
  assert.ok(value.includes('Top candidates'));
  assert.ok(value.includes('Open definition picker (F12)'));
  assert.ok(value.includes('A.scala:1'));
  assert.ok(value.includes('B.scala:1'));
});

test('FR-0041: ambiguous hover avoids claiming a single definition', async () => {
  const resolver = {
    resolveDefinitionCandidates: async () => ({
      kind: 'multiple' as const,
      symbolName: 'Foo',
      candidates: [
        { symbolName: 'Foo', filePath: '/workspace/src/A.scala', lineNumber: 1, symbolKind: 'def', visibility: 'public', packageName: 'com.example' }
      ],
      confidence: 'medium',
      stage: 'C',
      reason: 'stage-C-ambiguous'
    })
  } as Pick<GoToDefinitionProvider, 'resolveDefinitionCandidates'>;

  const provider = buildHoverProvider(resolver);

  const document = {
    uri: vscodeMock.Uri.file('/workspace/src/Main.scala'),
    getWordRangeAtPosition: () => new vscodeMock.Range(new vscodeMock.Position(0, 0), new vscodeMock.Position(0, 3)),
    getText: () => 'Foo'
  } as any;

  const token = new vscodeMock.CancellationTokenSource().token as any;
  const hover = await provider.provideHover(document, new vscodeMock.Position(0, 1) as any, token);

  assert.ok(hover);
  const value = (hover as any).contents[0].value as string;
  assert.ok(!value.includes('Defined at'));
});
