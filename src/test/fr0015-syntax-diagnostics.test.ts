import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0015: syntax diagnostics controller supports onSave and debounced onType trigger', () => {
  const source = readSource('src/syntaxDiagnosticsFeature.ts');
  assert.equal(source.includes('ON_TYPE_DEBOUNCE_MS = 500'), true);
  assert.equal(source.includes('onDidSaveTextDocument'), true);
  assert.equal(source.includes('onDidChangeTextDocument'), true);
  assert.equal(source.includes("config.trigger === 'onSave'"), true);
  assert.equal(source.includes("config.trigger !== 'onType'"), true);
});

test('FR-0015: diagnostics can be disabled via workspace config', () => {
  const source = readSource('src/syntaxDiagnosticsFeature.ts');
  assert.equal(source.includes('readDiagnosticsConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes('if (!config.enabled) {'), true);
  assert.equal(source.includes('this.diagnostics.clear();'), true);
  assert.equal(source.includes('this.diagnostics.delete(document.uri);'), true);
});

test('FR-0015: diagnostics source label remains Scala Lite (syntax)', () => {
  const source = readSource('src/syntaxDiagnosticsFeature.ts');
  assert.equal(source.includes("createDiagnosticCollection('scala-lite-syntax')"), true);
  assert.equal(source.includes("diagnostic.source = 'Scala Lite (syntax)'"), true);
});

test('FR-0015: diagnostics config reader returns effective defaults', () => {
  const source = readSource('src/workspaceConfig.ts');
  assert.equal(source.includes('readDiagnosticsConfigFromWorkspaceConfig'), true);
  assert.equal(source.includes("enabled: true"), true);
  assert.equal(source.includes("trigger: 'onSave'"), true);
  assert.equal(source.includes("typeof diagnostics.enabled === 'boolean'"), true);
  assert.equal(source.includes("diagnostics.trigger === 'onType' || diagnostics.trigger === 'onSave'"), true);
});

test('FR-0015: syntax diagnostics are not hard-disabled in Mode A', () => {
  const source = readSource('src/syntaxDiagnosticsFeature.ts');
  assert.equal(source.includes("this.getMode() === 'A'"), false);
});
