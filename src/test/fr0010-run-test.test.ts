import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createIndividualTestCommand,
  createSuiteTestCommand,
  detectTestCases,
  detectTestSuites,
  supportsIndividualTargeting
} from '../runTestLogic';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0010: detects ScalaTest suite and test cases', () => {
  const text = 'package sample\nclass MySuite extends AnyFunSuite {\n  test("works") {}\n}';
  const suites = detectTestSuites(text);
  assert.equal(suites.length, 1);
  assert.equal(suites[0].framework, 'scalatest');
  const cases = detectTestCases(text, suites[0].framework);
  assert.equal(cases[0].testName, 'works');
});

test('FR-0010: detects MUnit suite and test cases', () => {
  const text = 'class MySuite extends munit.FunSuite {\n  test("ok") {}\n}';
  const suites = detectTestSuites(text);
  assert.equal(suites.length, 1);
  assert.equal(suites[0].framework, 'munit');
  const cases = detectTestCases(text, suites[0].framework);
  assert.equal(cases[0].testName, 'ok');
});

test('FR-0010: detects Specs2, uTest, and ZIO Test suites', () => {
  const specs2 = detectTestSuites('class A extends Specification {}');
  const utest = detectTestSuites('object B extends utest.TestSuite {}');
  const zio = detectTestSuites('object C extends ZIOSpecDefault {}');

  assert.equal(specs2[0].framework, 'specs2');
  assert.equal(utest[0].framework, 'utest');
  assert.equal(zio[0].framework, 'ziotest');
});

test('FR-0010: suite run command generation per build tool', () => {
  const text = 'package sample\nclass MySuite extends AnyFunSuite {}';
  assert.equal(createSuiteTestCommand('sbt', '/tmp/MySuite.scala', 'MySuite', text, '__'), 'sbt "testOnly sample.MySuite"');
  assert.equal(createSuiteTestCommand('scala-cli', '/tmp/MySuite.scala', 'MySuite', text, '__'), 'scala-cli test "/tmp/MySuite.scala"');
  assert.equal(createSuiteTestCommand('mill', '/tmp/MySuite.scala', 'MySuite', text, 'core'), 'mill core.testOnly sample.MySuite');
});

test('FR-0010: individual test command generation for ScalaTest and MUnit', () => {
  const text = 'package sample\nclass MySuite extends AnyFunSuite {}';
  assert.equal(
    createIndividualTestCommand('sbt', 'scalatest', '/tmp/MySuite.scala', 'MySuite', 'works', text, '__'),
    'sbt \'testOnly sample.MySuite -- -z "works"\''
  );
  assert.equal(
    createIndividualTestCommand('sbt', 'munit', '/tmp/MySuite.scala', 'MySuite', 'works', text, '__'),
    'sbt \'testOnly sample.MySuite -- --test "works"\''
  );
});

test('FR-0010: unsupported frameworks do not support individual targeting', () => {
  assert.equal(supportsIndividualTargeting('specs2'), false);
  assert.equal(supportsIndividualTargeting('utest'), false);
  assert.equal(supportsIndividualTargeting('ziotest'), false);
});

test('FR-0010: test terminal symbiosis and unsupported label are wired', () => {
  const source = readSource('src/runTestFeature.ts');
  assert.equal(source.includes('Scala Lite: Test'), true);
  assert.equal(source.includes('terminal.sendText(command, true)'), true);
  assert.equal(source.includes('individual test not supported for'), true);
});

test('FR-0010: CodeLens provider is mode-gated to Mode B/C', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('runTestProvider'), true);
  assert.equal(source.includes("if (mode === 'A')"), true);
});
