import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('IN-0002: NativeEngine exposes required async TypeScript bridge methods', () => {
  const source = readSource('src/nativeEngine.ts');
  assert.equal(source.includes('class NativeEngine'), true);
  assert.equal(source.includes('public async parseFile('), true);
  assert.equal(source.includes('public async indexFiles('), true);
  assert.equal(source.includes('public async querySymbols('), true);
  assert.equal(source.includes('public async getDiagnostics('), true);
  assert.equal(source.includes('public async evictFile('), true);
  assert.equal(source.includes('public async rebuildIndex('), true);
  assert.equal(source.includes('public async getMemoryUsage('), true);
  assert.equal(source.includes('public async shutdown('), true);
});

test('IN-0002: status union and typed native errors are defined', () => {
  const source = readSource('src/nativeEngine.ts');
  assert.equal(source.includes("type NativeEngineStatus = 'active' | 'fallback' | 'crashed' | 'restarting'"), true);
  assert.equal(source.includes('class NativeEngineUnavailableError extends Error'), true);
  assert.equal(source.includes('class NativeEngineCrashError extends Error'), true);
});

test('IN-0002: binary resolution order includes platform native then WASM fallback', () => {
  const source = readSource('src/nativeEngine.ts');
  assert.equal(source.includes('platformBinaryFileName'), true);
  assert.equal(source.includes("source: 'native'"), true);
  assert.equal(source.includes("source: 'wasm'"), true);
  assert.equal(source.includes('Unable to load native addon from platform binary or WASM fallback.'), true);
});

test('IN-0002: cancellation token propagation and restart command wiring exist', () => {
  const bridgeSource = readSource('src/nativeEngine.ts');
  const stateSource = readSource('src/nativeEngineState.ts');

  assert.equal(bridgeSource.includes('cancellationToken?: vscode.CancellationToken'), true);
  assert.equal(bridgeSource.includes('withCancellation'), true);
  assert.equal(stateSource.includes("COMMAND_RESTART_NATIVE_ENGINE = 'scalaLite.restartNativeEngine'"), true);
  assert.equal(stateSource.includes('runtime.status = \'restarting\''), true);
});

test('IN-0002: package includes native build/test helper scripts', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    scripts: Record<string, string>;
  };

  assert.equal(typeof packageJson.scripts['native:build'], 'string');
  assert.equal(typeof packageJson.scripts['native:test'], 'string');
});

test('IN-0002: native bridge normalizes Rust payload field names to TypeScript model', () => {
  const source = readSource('src/nativeEngine.ts');
  assert.equal(source.includes('normalizeNativeSymbol('), true);
  assert.equal(source.includes('raw.file_path'), true);
  assert.equal(source.includes('raw.line_number'), true);
  assert.equal(source.includes('raw.container_name'), true);
  assert.equal(source.includes('normalizeNativeParseResult('), true);
});

test('IN-0002: hover provider is wired for non-Mode-A states', () => {
  const extensionSource = readSource('src/extension.ts');
  const modeSource = readSource('src/modeManager.ts');
  const hoverSource = readSource('src/hoverInfoFeature.ts');

  assert.equal(extensionSource.includes('new HoverInfoProvider(definitionProvider, () => activeMode, logger)'), true);
  assert.equal(modeSource.includes('registerHoverProvider'), true);
  assert.equal(modeSource.includes('readonly hoverProvider?: vscode.HoverProvider;'), true);
  assert.equal(hoverSource.includes('readDefinitionPreview'), true);
  assert.equal(hoverSource.includes("appendCodeblock(definitionPreview, 'scala')"), true);
    assert.equal(hoverSource.includes('readDependencyAttachmentForPath'), true);
    assert.equal(hoverSource.includes('scalaLite.openDependencyAttachment'), true);
    assert.equal(hoverSource.includes("vscode.l10n.t('Definition')"), true);
});
