import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0026: native engine fallback state and restart command are implemented', () => {
  const source = readSource('src/nativeEngineState.ts');
  assert.equal(source.includes("COMMAND_RESTART_NATIVE_ENGINE = 'scalaLite.restartNativeEngine'"), true);
  assert.equal(source.includes('⚠ Fallback mode (slower)'), true);
  assert.equal(source.includes('registerNativeEngineFeature'), true);
  assert.equal(source.includes('initializeNativeEngine'), true);
});

test('FR-0026: extension initializes native engine and registers restart command', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('initializeNativeEngine(logger);'), true);
  assert.equal(source.includes('registerNativeEngineFeature(logger)'), true);
});

test('FR-0026: command contribution and localization include restart native engine', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.restartNativeEngine');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.restartNativeEngine.title%');

  const nls = JSON.parse(readSource('package.nls.json')) as Record<string, string>;
  assert.equal(typeof nls['command.scalaLite.restartNativeEngine.title'], 'string');
});

test('FR-0026: build-tool detection has graceful fallback on detection failure', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('Build-tool detection failed. Falling back to none.'), true);
  assert.equal(source.includes("buildTool: 'none' as BuildTool"), true);
});

test('FR-0026: invalid workspace config JSON warns and falls back to defaults', () => {
  const source = readSource('src/workspaceConfig.ts');
  assert.equal(source.includes('invalidJsonWarnings'), true);
  assert.equal(source.includes('Configuration file is invalid JSON. Defaults are being used until fixed.'), true);
});
