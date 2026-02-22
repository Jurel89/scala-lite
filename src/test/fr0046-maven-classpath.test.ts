import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0046: sync classpath command is wired to Maven provider resolution flow', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes("COMMAND_SYNC_CLASSPATH = 'scalaLite.syncClasspath'"), true);
  assert.equal(source.includes('prepareClasspathSync'), true);
  assert.equal(source.includes('syncMavenClasspathWithJdk'), true);
});

test('FR-0046: Maven classpath resolution runs dependency:build-classpath and writes classpath cache', () => {
  const source = readSource('src/mavenProvider.ts');

  assert.equal(source.includes('dependency:build-classpath'), true);
  assert.equal(source.includes('classpath-'), true);
  assert.equal(source.includes('writeClasspathCache'), true);
});
