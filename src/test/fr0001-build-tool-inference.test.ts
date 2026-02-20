import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferBuildToolFromSignals } from '../buildToolInference';

const baseSignals = {
  hasSbtRoot: false,
  hasSbtImmediateChild: false,
  hasSbtProjectBuildPropertiesRoot: false,
  hasSbtProjectBuildPropertiesImmediateChild: false,
  hasMillRoot: false,
  hasScalaBuildDirectoryRoot: false,
  scalaSourceSnippets: [],
  mavenPomSnippets: [],
  gradleBuildSnippets: []
} as const;

test('FR-0001: detects sbt by build.sbt signature', () => {
  const buildTool = inferBuildToolFromSignals({
    ...baseSignals,
    hasSbtRoot: true
  });

  assert.equal(buildTool, 'sbt');
});

test('FR-0001: detects mill by build.sc signature', () => {
  const buildTool = inferBuildToolFromSignals({
    ...baseSignals,
    hasMillRoot: true
  });

  assert.equal(buildTool, 'mill');
});

test('FR-0001: detects scala-cli by //> using directive', () => {
  const buildTool = inferBuildToolFromSignals({
    ...baseSignals,
    scalaSourceSnippets: ['//> using scala 3.4.2\n@main def hello = println("hi")']
  });

  assert.equal(buildTool, 'scala-cli');
});

test('FR-0001: detects maven by scala artifact id', () => {
  const buildTool = inferBuildToolFromSignals({
    ...baseSignals,
    mavenPomSnippets: ['<project><artifactId>scala-service</artifactId></project>']
  });

  assert.equal(buildTool, 'maven');
});

test('FR-0001: detects gradle by scala plugin references', () => {
  const buildTool = inferBuildToolFromSignals({
    ...baseSignals,
    gradleBuildSnippets: ['plugins { id("scala") }']
  });

  assert.equal(buildTool, 'gradle');
});

test('FR-0001: falls back to no build integration when nothing detected', () => {
  const buildTool = inferBuildToolFromSignals(baseSignals);
  assert.equal(buildTool, 'none');
});