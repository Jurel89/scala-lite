import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BudgetRunner, runWithBudgetExtension } from '../budgetCore';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0018: BudgetRunner stops around configured time budget', async () => {
  const budgetMs = 80;
  const runner = new BudgetRunner<void>({
    operationName: 'test-budget',
    timeBudgetMs: budgetMs
  });

  const result = await runner.run(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'time');
  // Use generous tolerance to avoid flakes on slow CI systems
  assert.equal(result.elapsedMs <= budgetMs + 200, true);
});

test('FR-0018: extend action doubles budget and re-runs operation', async () => {
  let attempts = 0;

  const execution = await runWithBudgetExtension({
    operationName: 'find-usages',
    initialTimeBudgetMs: 100,
    executeWithBudget: async (timeBudgetMs) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 'stopped' as const,
          elapsedMs: 101,
          stopReason: 'time' as const,
          cpuDeltaMicros: 10
        };
      }

      return {
        status: 'completed' as const,
        elapsedMs: Math.min(200, timeBudgetMs),
        value: 'ok',
        cpuDeltaMicros: 20
      };
    },
    requestAction: async () => 'extend'
  });

  assert.equal(attempts, 2);
  assert.equal(execution.finalBudgetMs, 200);
  assert.equal(execution.result.status, 'completed');
  assert.equal(execution.result.value, 'ok');
});

test('FR-0018: build diagnostics runner uses budget extension envelope and budget logs', () => {
  const source = readSource('src/buildDiagnostics.ts');
  assert.equal(source.includes('runWithBudgetExtension'), true);
  assert.equal(source.includes("'BUDGET'"), true);
  assert.equal(source.includes('stopped at budget limit'), true);
});

test('FR-0018: workspace config supports formatterTimeMs in budgets', () => {
  const schema = JSON.parse(readSource('schema/scala-lite.schema.json')) as {
    properties: {
      budgets: {
        properties: Record<string, unknown>;
      };
    };
  };

  assert.equal(Boolean(schema.properties.budgets.properties.formatterTimeMs), true);

  const workspaceConfigSource = readSource('src/workspaceConfig.ts');
  assert.equal(workspaceConfigSource.includes('formatterTimeMs'), true);
});

test('FR-0018: formatter and linter timeout defaults read from budget config', () => {
  const scalafmtSource = readSource('src/scalafmtFeature.ts');
  const scalafixSource = readSource('src/scalafixFeature.ts');

  assert.equal(scalafmtSource.includes('readBudgetConfigFromWorkspaceConfig'), true);
  assert.equal(scalafixSource.includes('readBudgetConfigFromWorkspaceConfig'), true);
});
