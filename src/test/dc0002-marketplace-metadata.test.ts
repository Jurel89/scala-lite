import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('DC-0002: package metadata includes Marketplace keywords, categories, preview, badges', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    description: string;
    categories: string[];
    keywords: string[];
    preview: boolean;
    badges: Array<{ description: string }>;
  };

  assert.equal(packageJson.description.length <= 200, true);
  assert.deepEqual(packageJson.keywords, ['scala', 'sbt', 'mill', 'scala-cli', 'formatter']);
  assert.equal(packageJson.categories.includes('Programming Languages'), true);
  assert.equal(packageJson.categories.includes('Formatters'), true);
  assert.equal(packageJson.categories.includes('Linters'), true);
  assert.equal(packageJson.preview, true);
  assert.equal(packageJson.badges.some((badge) => badge.description === 'CI Status'), true);
  assert.equal(packageJson.badges.some((badge) => badge.description === 'MIT License'), true);
});
