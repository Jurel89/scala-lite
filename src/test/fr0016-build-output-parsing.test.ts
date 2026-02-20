import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseBuildOutputLine } from '../buildOutputParser';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0016: parses sbt error format', () => {
  const parsed = parseBuildOutputLine('[error] src/main/scala/App.scala:12:8: not found: value foo');
  assert.ok(parsed);
  assert.equal(parsed?.filePath, 'src/main/scala/App.scala');
  assert.equal(parsed?.line, 12);
  assert.equal(parsed?.column, 8);
  assert.equal(parsed?.severity, 'error');
});

test('FR-0016: parses scala-cli error format', () => {
  const parsed = parseBuildOutputLine('-- Error: /tmp/App.scala:3:15 ---------');
  assert.ok(parsed);
  assert.equal(parsed?.filePath, '/tmp/App.scala');
  assert.equal(parsed?.line, 3);
  assert.equal(parsed?.column, 15);
  assert.equal(parsed?.severity, 'error');
});

test('FR-0016: parses mill and scalac generic error format', () => {
  const mill = parseBuildOutputLine('src/main/scala/App.scala:7: error: type mismatch');
  const scalac = parseBuildOutputLine('/tmp/App.scala:9:13: warning: deprecation');

  assert.ok(mill);
  assert.equal(mill?.severity, 'error');
  assert.ok(scalac);
  assert.equal(scalac?.severity, 'warning');
});

test('FR-0016: malformed lines are ignored', () => {
  const parsed = parseBuildOutputLine('this line has no diagnostic structure');
  assert.equal(parsed, undefined);
});

test('FR-0016: diagnostics source label and clear behavior are present', () => {
  const source = readSource('src/buildDiagnostics.ts');
  assert.equal(source.includes("diagnostic.source = 'Scala Lite (build)'"), true);
  assert.equal(source.includes('this.diagnostics.clear();'), true);
});
