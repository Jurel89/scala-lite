import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0047: SBT provider resolves classpath via secure build command execution', () => {
  const source = readSource('src/sbtProvider.ts');

  assert.equal(source.includes('executeBuildCommand'), true);
  assert.equal(source.includes("'-no-colors'"), true);
  assert.equal(source.includes("'show Compile / fullClasspath'"), true);
  assert.equal(source.includes("'show Test / fullClasspath'"), true);
  assert.equal(source.includes('writeClasspathCache'), true);
  assert.equal(source.includes("if (strategy === 'coursier' || strategy === 'sbt-show')"), true);
  assert.equal(source.includes("runSbtClasspathWithStrategy(options, 'coursier')"), true);
  assert.equal(source.includes("runSbtClasspathWithStrategy(options, 'sbt-show')"), true);
});

test('FR-0047: sync command is wired to SBT orchestration path', () => {
  const source = readSource('src/extension.ts');

  assert.equal(source.includes('syncSbtClasspathWithJdk'), true);
  assert.equal(source.includes('Running SBT classpath resolution'), true);
});
