import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0001: activation performance budget constant and recording are defined', () => {
  const source = readSource('src/activationPerformance.ts');
  assert.equal(source.includes('ACTIVATION_BUDGET_MS = 500'), true);
  assert.equal(source.includes('recordActivationDuration'), true);
  assert.equal(source.includes('Activation exceeded performance budget'), true);
});

test('PF-0001: extension records activation elapsed time and shows budget warning', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('const activationStartedAt = Date.now();'), true);
  assert.equal(source.includes('recordActivationDuration(activationElapsed, logger);'), true);
  assert.equal(source.includes('Activation exceeded budget: {0}ms (> {1}ms).'), true);
});

test('PF-0001: activation audit command is contributed and registered', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.runActivationAudit');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.runActivationAudit.title%');

  const source = readSource('src/activationPerformance.ts');
  assert.equal(source.includes("COMMAND_RUN_ACTIVATION_AUDIT = 'scalaLite.runActivationAudit'"), true);
  assert.equal(source.includes('registerActivationPerformanceFeature'), true);
});

test('PF-0001: activation path does not invoke child process spawn directly', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('spawn('), false);
});
