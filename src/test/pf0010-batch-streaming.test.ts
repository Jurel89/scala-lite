import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0010: workspace config supports budgets.indexBatchSize with sane defaults', () => {
  const config = readSource('src/workspaceConfig.ts');
  const schema = readSource('schema/scala-lite.schema.json');

  assert.equal(config.includes('readIndexBatchSizeFromWorkspaceConfig'), true);
  assert.equal(config.includes('return 100;'), true);
  assert.equal(config.includes('Math.min(1000, Math.max(1, Math.round(value)))'), true);

  assert.equal(schema.includes('"indexBatchSize"'), true);
  assert.equal(schema.includes('"default": 100'), true);
});

test('PF-0010: Mode C rebuild uses configurable batch size and progress messages', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('const batchSize = await readIndexBatchSizeFromWorkspaceConfig();'), true);
  assert.equal(source.includes('const totalBatches = Math.max(1, Math.ceil(filteredFiles.length / batchSize));'), true);
  assert.equal(source.includes("title: vscode.l10n.t('Scala Lite: Rebuilding index')"), true);
  assert.equal(source.includes("message: vscode.l10n.t('Indexing batch {0}/{1}…'"), true);
  assert.equal(source.includes('await this.appendNativeIndexBatch(nativeBatch, token);'), true);
});
