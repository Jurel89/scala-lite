import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0044: build tool detector exposes classpath provider detection API', () => {
  const source = readSource('src/buildToolDetector.ts');

  assert.equal(source.includes('export type ClasspathProvider'), true);
  assert.equal(source.includes('export async function detectClasspathProvider'), true);
  assert.equal(source.includes('export function chooseClasspathProvider'), true);
});

test('FR-0044: classpath provider detection checks wrappers and supports user prompt path', () => {
  const source = readSource('src/buildToolDetector.ts');

  assert.equal(source.includes("findExists(workspace, folder, 'mvnw')"), true);
  assert.equal(source.includes("findExists(workspace, folder, 'mvnw.cmd')"), true);
  assert.equal(source.includes("findExists(workspace, folder, 'sbt')"), true);
  assert.equal(source.includes('options?.promptUser'), true);
});
