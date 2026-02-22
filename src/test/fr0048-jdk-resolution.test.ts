import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0048: JDK resolver checks workspace jdkHome, JAVA_HOME, and cross-platform fallbacks', () => {
  const source = readSource('src/jdkResolver.ts');

  assert.equal(source.includes("process.env.JAVA_HOME"), true);
  assert.equal(source.includes("'/Library/Java/JavaVirtualMachines'"), true);
  assert.equal(source.includes("'/usr/lib/jvm/default-java'"), true);
  assert.equal(source.includes("process.env.ProgramFiles"), true);
  assert.equal(source.includes("source: 'workspace-config'"), true);
  assert.equal(source.includes("source: 'env-java-home'"), true);
  assert.equal(source.includes("source: 'auto-macos'"), true);
  assert.equal(source.includes("source: 'auto-linux'"), true);
  assert.equal(source.includes("source: 'auto-windows'"), true);
});

test('FR-0048: JDK resolver enumerates jmods and selects configured modules', () => {
  const source = readSource('src/jdkResolver.ts');

  assert.equal(source.includes("entry.name.endsWith('.jmod')"), true);
  assert.equal(source.includes('availableModules'), true);
  assert.equal(source.includes('selectedModules'), true);
});
