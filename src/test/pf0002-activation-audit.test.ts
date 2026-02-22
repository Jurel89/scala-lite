import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0002: activation only allows guarded Mode C memory audit interval', () => {
  const extensionSource = readSource('src/extension.ts');

  const intervalCalls = (extensionSource.match(/setInterval\(/g) ?? []).length;
  assert.equal(intervalCalls, 1);
  assert.equal(extensionSource.includes("if (activeMode !== 'C') {"), true);
  assert.equal(extensionSource.includes('MODE_C_BUDGET_AUDIT_INTERVAL_MS'), true);
  assert.equal(extensionSource.includes('clearInterval(modeCBudgetAuditTimer);'), true);
  assert.equal(extensionSource.includes('const modeCBudgetTimerDisposable = new vscode.Disposable(() => {'), true);
});

test('PF-0002: no setTimeout in activation path', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('setTimeout('), false);
});

test('PF-0002: no file watchers registered in default mode', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('createFileSystemWatcher('), false);
});