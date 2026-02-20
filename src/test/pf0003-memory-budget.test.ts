import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0003: mode-specific memory budgets are defined', () => {
  const source = readSource('src/memoryBudget.ts');
  assert.equal(source.includes('A: {'), true);
  assert.equal(source.includes('maxTotalBytes: 25 * MB'), true);
  assert.equal(source.includes('maxHeapBytes: 20 * MB'), true);
  assert.equal(source.includes('maxNativeBytes: 5 * MB'), true);

  assert.equal(source.includes('B: {'), true);
  assert.equal(source.includes('maxTotalBytes: 55 * MB'), true);
  assert.equal(source.includes('maxHeapBytes: 30 * MB'), true);
  assert.equal(source.includes('maxNativeBytes: 25 * MB'), true);

  assert.equal(source.includes('C: {'), true);
  assert.equal(source.includes('maxTotalBytes: 100 * MB'), true);
  assert.equal(source.includes('maxHeapBytes: 30 * MB'), true);
  assert.equal(source.includes('maxNativeBytes: 70 * MB'), true);
});

test('PF-0003: audit samples heap and native memory then logs budget compliance', () => {
  const source = readSource('src/memoryBudget.ts');
  assert.equal(source.includes('process.memoryUsage().heapUsed'), true);
  assert.equal(source.includes('__scalaLiteNativeMemoryUsage'), true);
  assert.equal(source.includes('[MEMORY] Budget exceeded.'), true);
  assert.equal(source.includes("logger.info('BUDGET'"), true);
});

test('PF-0003: memory budget audit command is contributed and registered', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.runMemoryBudgetAudit');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.runMemoryBudgetAudit.title%');

  const source = readSource('src/memoryBudget.ts');
  assert.equal(source.includes("COMMAND_RUN_MEMORY_BUDGET_AUDIT = 'scalaLite.runMemoryBudgetAudit'"), true);
  assert.equal(source.includes('registerMemoryBudgetFeature'), true);
});

test('PF-0003: mode changes trigger memory budget audit', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('auditMemoryBudgetForMode(mode, logger);'), true);
});
