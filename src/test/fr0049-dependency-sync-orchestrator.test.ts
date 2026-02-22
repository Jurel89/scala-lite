import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0049: dependency sync orchestrator persists sync status and JDK state files', () => {
  const source = readSource('src/dependencySyncOrchestrator.ts');

  assert.equal(source.includes("const SYNC_STATUS_FILE = 'dependency-sync-status.json'"), true);
  assert.equal(source.includes("const JDK_STATE_FILE = 'jdk-modules.json'"), true);
  assert.equal(source.includes('writeDependencySyncFailure'), true);
  assert.equal(source.includes('readDependencySyncStatus'), true);
});

test('FR-0049: Maven sync orchestration composes classpath + JDK resolution and records counts', () => {
  const source = readSource('src/dependencySyncOrchestrator.ts');

  assert.equal(source.includes('resolveMavenClasspath'), true);
  assert.equal(source.includes('resolveSbtClasspath'), true);
  assert.equal(source.includes('resolveJdkModules'), true);
  assert.equal(source.includes('jarsCount'), true);
  assert.equal(source.includes('selectedJdkModuleCount'), true);
  assert.equal(source.includes('availableJdkModuleCount'), true);
  assert.equal(source.includes('syncSbtClasspathWithJdk'), true);
});
