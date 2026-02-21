import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

type NativeEngineCtor = new () => {
  parseFile(filePath: string, content: string): {
    filePath: string;
    symbols: Array<Record<string, unknown>>;
    imports: Array<Record<string, unknown>>;
    diagnostics: Array<Record<string, unknown>>;
  };
  indexFiles(files: Array<{ filePath: string; content: string }>): number;
  querySymbols(query: string, limit: number): Array<Record<string, unknown>>;
  querySymbolsInPackage(query: string, packagePath: string, limit: number): Array<Record<string, unknown>>;
  queryPackageExists(packagePath: string): boolean;
};

function loadNativeEngineCtor(): NativeEngineCtor | undefined {
  try {
    const modulePath = path.resolve(process.cwd(), 'native/scala-lite-engine/index.js');
    const loaded = require(modulePath) as { NativeEngine?: NativeEngineCtor };
    return loaded.NativeEngine;
  } catch {
    return undefined;
  }
}

test('IN-0004: native runtime contract exposes enriched parse/query APIs', (t) => {
  const NativeEngine = loadNativeEngineCtor();
  if (!NativeEngine) {
    t.skip('Native engine binding unavailable on this environment.');
    return;
  }

  const engine = new NativeEngine();
  const parseResult = engine.parseFile(
    '/tmp/runtime-contract.scala',
    [
      'package demo.contract',
      'import demo.models.User',
      'private class Internal',
      'val publicValue = 1'
    ].join('\n')
  );

  assert.equal(typeof parseResult.filePath, 'string');
  assert.equal(Array.isArray(parseResult.symbols), true);
  assert.equal(Array.isArray(parseResult.imports), true);
  assert.equal(Array.isArray(parseResult.diagnostics), true);

  const firstImport = parseResult.imports[0];
  const importPackagePath = (firstImport?.packagePath ?? firstImport?.package_path) as unknown;
  assert.equal(typeof importPackagePath, 'string');
  assert.equal(typeof firstImport?.isWildcard, 'boolean');

  const internalClass = parseResult.symbols.find((entry) => entry.name === 'Internal');
  const symbolPackageName = (internalClass?.packageName ?? internalClass?.package_name) as unknown;
  assert.equal(typeof symbolPackageName, 'string');
  assert.equal(typeof internalClass?.visibility, 'string');

  const indexed = engine.indexFiles([
    {
      filePath: '/tmp/a.scala',
      content: 'package demo.contract\nclass User\n'
    },
    {
      filePath: '/tmp/b.scala',
      content: 'package demo.contract\nobject User\n'
    }
  ]);

  assert.equal(typeof indexed, 'number');
  assert.equal(engine.queryPackageExists('demo.contract'), true);

  const packageMatches = engine.querySymbolsInPackage('User', 'demo.contract', 10);
  assert.equal(packageMatches.length >= 2, true);
  assert.equal(packageMatches.every((entry) => (entry.packageName ?? entry.package_name) === 'demo.contract'), true);
});
