import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './vscode-mock';
import {
  ACTIVATION_BUDGET_MS,
  COMMAND_RUN_ACTIVATION_AUDIT,
  recordActivationDuration
} from '../activationPerformance';
import { StructuredLogger } from '../structuredLogger';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0001: activation performance budget is 500ms', () => {
  assert.equal(ACTIVATION_BUDGET_MS, 500);
});

test('PF-0001: recordActivationDuration logs without throwing for normal and over-budget durations', () => {
  const logger = new StructuredLogger('INFO');
  assert.doesNotThrow(() => recordActivationDuration(100, logger));
  assert.doesNotThrow(() => recordActivationDuration(600, logger));
  assert.doesNotThrow(() => recordActivationDuration(-5, logger));
});

test('PF-0001: activation audit command constant matches package.json contribution', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  assert.equal(COMMAND_RUN_ACTIVATION_AUDIT, 'scalaLite.runActivationAudit');
  const command = packageJson.contributes.commands.find(
    (entry) => entry.command === COMMAND_RUN_ACTIVATION_AUDIT
  );
  assert.ok(command, 'activation audit command must be contributed in package.json');
});

test('PF-0001: activation path does not invoke child process spawn directly', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('spawn('), false);
});
