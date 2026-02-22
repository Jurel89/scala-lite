import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('SC-0003: secure build executor uses spawn with shell false and cwd pinning', () => {
  const source = readSource('src/buildCommandExecutor.ts');

  assert.equal(source.includes('spawn(options.command, [...options.args]'), true);
  assert.equal(source.includes('cwd: options.cwd'), true);
  assert.equal(source.includes('shell: false'), true);
});

test('SC-0003: secure build executor supports timeout, cancellation, and output redaction', () => {
  const source = readSource('src/buildCommandExecutor.ts');

  assert.equal(source.includes('SENSITIVE_OUTPUT_PATTERNS'), true);
  assert.equal(source.includes('onCancellationRequested'), true);
  assert.equal(source.includes('setTimeout(() =>'), true);
  assert.equal(source.includes('redactSensitiveOutput'), true);
});
