import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0003: package contributes Scala and SBT TextMate grammars', () => {
  const packageJson = readSource('package.json');
  assert.equal(packageJson.includes('"languages"'), true);
  assert.equal(packageJson.includes('"language": "scala"'), true);
  assert.equal(packageJson.includes('"language": "scala-sbt"'), true);
  assert.equal(packageJson.includes('"./syntaxes/scala.tmLanguage.json"'), true);
  assert.equal(packageJson.includes('"./syntaxes/sbt.tmLanguage.json"'), true);
});

test('FR-0003: Scala grammar includes Scala 3 and Scala 2 declaration keywords', () => {
  const grammar = readSource('syntaxes/scala.tmLanguage.json');
  assert.equal(grammar.includes('given'), true);
  assert.equal(grammar.includes('using'), true);
  assert.equal(grammar.includes('extension'), true);
  assert.equal(grammar.includes('enum'), true);
  assert.equal(grammar.includes('export'), true);
  assert.equal(grammar.includes('implicit'), true);
  assert.equal(grammar.includes('lazy'), true);
  assert.equal(grammar.includes('sealed'), true);
});

test('FR-0003: grammar highlights interpolation forms s/f/raw with embedded variables', () => {
  const grammar = readSource('syntaxes/scala.tmLanguage.json');
  assert.equal(grammar.includes('(?:s|f|raw)'), true);
  assert.equal(grammar.includes('variable.interpolation.scala'), true);
});

test('FR-0003: sbt grammar includes build-specific keyword hints', () => {
  const grammar = readSource('syntaxes/sbt.tmLanguage.json');
  assert.equal(grammar.includes('libraryDependencies'), true);
  assert.equal(grammar.includes('scalaVersion'), true);
  assert.equal(grammar.includes('crossScalaVersions'), true);
});
