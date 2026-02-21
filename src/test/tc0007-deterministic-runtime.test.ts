import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSymbols } from '../symbolSort';
import type { IndexedSymbol } from '../symbolIndex';

function makeSymbol(index: number): IndexedSymbol {
  return {
    symbolName: `item${String(100 - index).padStart(3, '0')}`,
    symbolKind: index % 2 === 0 ? 'def' : 'val',
    filePath: '/tmp/same.scala',
    lineNumber: 10,
    packageName: 'demo.pkg',
    visibility: 'public',
    containerName: 'Demo'
  };
}

test('TC-0007: sorting 100 same-path symbols is stable and reproducible', () => {
  const symbols = Array.from({ length: 100 }, (_, index) => makeSymbol(index));

  const runOne = [...symbols].sort((left, right) => compareSymbols(left, right)).map((entry) => entry.symbolName);
  const runTwo = [...symbols].sort((left, right) => compareSymbols(left, right)).map((entry) => entry.symbolName);
  const runThree = [...symbols].sort((left, right) => compareSymbols(left, right)).map((entry) => entry.symbolName);

  assert.deepEqual(runOne, runTwo);
  assert.deepEqual(runTwo, runThree);
  assert.equal(runOne.length, 100);
});
