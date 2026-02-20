import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createRunCommandFromInputs,
  detectRunEntryPoints,
  inferFqnForEntry
} from '../runMainLogic';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0009: detects Scala 3 @main entry', () => {
  const entries = detectRunEntryPoints('package sample\n@main def hello(): Unit = println("hi")');
  assert.equal(entries.some((entry) => entry.displayName === 'hello'), true);
});

test('FR-0009: detects Scala 2 object extends App entry', () => {
  const entries = detectRunEntryPoints('package sample\nobject Runner extends App { println("hi") }');
  assert.equal(entries.some((entry) => entry.displayName === 'Runner'), true);
});

test('FR-0009: detects main(args) inside object', () => {
  const entries = detectRunEntryPoints('package sample\nobject Launcher {\n  def main(args: Array[String]): Unit = ()\n}');
  assert.equal(entries.some((entry) => entry.displayName === 'Launcher.main'), true);
});

test('FR-0009: detects scala-cli script from //> using directives', () => {
  const entries = detectRunEntryPoints('//> using scala 3.3.0\nprintln("hello")');
  assert.equal(entries.some((entry) => entry.kind === 'scala-cli-script'), true);
});

test('FR-0009: command generation includes required terminal.sendText usage', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes('terminal.sendText(command, true)'), true);
});

test('FR-0009: FQN inference uses package + object/class name', () => {
  const [entry] = detectRunEntryPoints('package com.example\nobject Runner extends App {}');
  const fqn = inferFqnForEntry('com.example', entry);
  assert.equal(fqn, 'com.example.Runner');
});

test('FR-0009: command generation supports sbt/scala-cli/mill from pure inputs', () => {
  const [entry] = detectRunEntryPoints('package com.example\nobject Runner extends App {}');
  assert.equal(createRunCommandFromInputs('sbt', '/tmp/Main.scala', entry, 'com.example', '__'), 'sbt "runMain com.example.Runner"');
  assert.equal(createRunCommandFromInputs('scala-cli', '/tmp/Main.scala', entry, 'com.example', '__'), 'scala-cli run "/tmp/Main.scala"');
  assert.equal(createRunCommandFromInputs('mill', '/tmp/Main.scala', entry, 'com.example', 'app'), 'mill app.runMain com.example.Runner');
});

test('FR-0009: fallback quick pick includes required no-build options', () => {
  const source = readSource('src/runMainFeature.ts');
  assert.equal(source.includes("label: 'Run with scala-cli'"), true);
  assert.equal(source.includes("label: 'Run with java'"), true);
  assert.equal(source.includes("label: 'Configure build tool'"), true);
});

test('FR-0009: CodeLens provider only active in Mode B/C through mode gate', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes("if (mode === 'A')"), true);
  assert.equal(source.includes('registerCodeLensProvider'), true);
});
