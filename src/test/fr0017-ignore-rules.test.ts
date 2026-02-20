import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_IGNORES,
  HARD_SAFETY_IGNORES,
  resolveIgnoreRules,
  toRipgrepExcludeGlobArgs
} from '../ignoreRulesCore';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0017: hard safety ignores cannot be removed unless unsafeMode is true', () => {
  const resolved = resolveIgnoreRules({
    unsafeMode: false,
    ignorePatterns: ['!target/', '!node_modules/']
  });

  assert.equal(resolved.effectivePatterns.includes('target/'), true);
  assert.equal(resolved.effectivePatterns.includes('node_modules/'), false);
  assert.equal(resolved.blockedHardSafetyRemovals.includes('target/'), true);
});

test('FR-0017: unsafe mode allows hard safety ignore removal and emits warning', () => {
  const resolved = resolveIgnoreRules({
    unsafeMode: true,
    ignorePatterns: ['!target/']
  });

  assert.equal(resolved.effectivePatterns.includes('target/'), false);
  assert.equal(
    resolved.warnings.includes('Unsafe mode enabled. Performance guardrails weakened. Scanning may be slow.'),
    true
  );
});

test('FR-0017: invalid glob syntax is reported without crashing', () => {
  const resolved = resolveIgnoreRules({
    unsafeMode: false,
    ignorePatterns: ['[invalid']
  });

  assert.equal(resolved.invalidPatterns.includes('[invalid'), true);
  assert.equal(
    resolved.warnings.includes('One or more ignore patterns are invalid and were skipped.'),
    true
  );
});

test('FR-0017: ripgrep glob exclusions are generated from effective ignore rules', () => {
  const resolved = resolveIgnoreRules({
    unsafeMode: false,
    ignorePatterns: ['generated/**']
  });
  const args = toRipgrepExcludeGlobArgs(resolved.effectivePatterns);

  assert.equal(args.includes('--glob=!target/'), true);
  assert.equal(args.includes('--glob=!generated/**'), true);
});

test('FR-0017: schema supports ignorePatterns and unsafeMode', () => {
  const schemaText = readSource('schema/scala-lite.schema.json');
  const schema = JSON.parse(schemaText) as {
    properties: {
      ignorePatterns?: unknown;
      unsafeMode?: unknown;
    };
  };

  assert.equal(Boolean(schema.properties.ignorePatterns), true);
  assert.equal(Boolean(schema.properties.unsafeMode), true);
});

test('FR-0017: activation validates ignore rules at startup', () => {
  const extensionSource = readSource('src/extension.ts');
  assert.equal(extensionSource.includes('validateIgnoreRulesAtActivation(logger)'), true);
});

test('FR-0017: hard and default ignore sets match MVP requirement lists', () => {
  assert.deepEqual(HARD_SAFETY_IGNORES, [
    'target/',
    '.bloop/',
    '.metals/',
    '.scala-build/',
    '.idea/',
    '.bsp/',
    '.ammonite/'
  ]);

  assert.deepEqual(DEFAULT_IGNORES, [
    'node_modules/',
    'dist/',
    'out/',
    '.git/',
    '__pycache__/',
    'build/',
    '.gradle/'
  ]);
});
