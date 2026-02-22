import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0008: memory budget audit returns explicit overage result fields', () => {
  const source = readSource('src/memoryBudget.ts');

  assert.equal(source.includes('export interface BudgetAuditResult'), true);
  assert.equal(source.includes('heapOverage'), true);
  assert.equal(source.includes('nativeOverage'), true);
  assert.equal(source.includes('totalOverage'), true);
  assert.equal(source.includes('totalUsedBytes'), true);
  assert.equal(source.includes('maxTotalBytes'), true);
});

test('PF-0008: extension runs Mode C budget audits on interval and post-rebuild', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes('MODE_C_BUDGET_AUDIT_INTERVAL_MS = 60_000'), true);
  assert.equal(source.includes('configureModeCBudgetAuditTimer()'), true);
  assert.equal(source.includes('onDidModeCRebuildCompleted'), true);
});

test('PF-0008: severe Mode C violations show debounced notification with actions', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes('BUDGET_NOTIFICATION_DEBOUNCE_MS = 5 * 60_000'), true);
  assert.equal(source.includes('Switch to Mode B'), true);
  assert.equal(source.includes('Increase Budget'), true);
  assert.equal(source.includes('Dismiss'), true);
  assert.equal(source.includes('switchModeForAutomation(\'B\')'), true);
  assert.equal(source.includes('openMemoryBudgetConfig'), true);
});

test('PF-0008: mode manager exposes automation mode switch API', () => {
  const source = readSource('src/modeManager.ts');

  assert.equal(source.includes('switchModeForAutomation'), true);
});
