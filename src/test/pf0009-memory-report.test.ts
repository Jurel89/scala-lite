import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('PF-0009: memory report command is contributed and localized', () => {
  const packageJson = JSON.parse(readSource('package.json')) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
    };
  };

  const command = packageJson.contributes.commands.find((entry) => entry.command === 'scalaLite.memoryReport');
  assert.ok(command);
  assert.equal(command?.title, '%command.scalaLite.memoryReport.title%');

  const nls = JSON.parse(readSource('package.nls.json')) as Record<string, string>;
  assert.equal(nls['command.scalaLite.memoryReport.title'], 'Memory Report');
});

test('PF-0009: SymbolIndexManager exposes typed memory breakdown', () => {
  const source = readSource('src/symbolIndex.ts');

  assert.equal(source.includes('export interface MemoryBreakdown'), true);
  assert.equal(source.includes('getMemoryBreakdown()'), true);
  assert.equal(source.includes('estimatedJsHeapBytes'), true);
  assert.equal(source.includes('nativeMemoryUsage'), true);
});

test('PF-0009: memory budget feature registers memory report command and output channel', () => {
  const source = readSource('src/memoryBudget.ts');

  assert.equal(source.includes("COMMAND_MEMORY_REPORT = 'scalaLite.memoryReport'"), true);
  assert.equal(source.includes("createOutputChannel('Scala Lite Memory')"), true);
  assert.equal(source.includes('Mode heap budget (bytes):'), true);
  assert.equal(source.includes('[MEMORY_REPORT]'), true);
});
