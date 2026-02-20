import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applyProfileCommandShape,
  generateDefaultProfile,
  renderTemplate
} from '../profileCore';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0011: profile templates expand {{mainClass}} and {{suiteName}} placeholders', () => {
  const runExpanded = renderTemplate('sbt "runMain {{mainClass}}"', {
    mainClass: 'com.example.Main'
  });
  const testExpanded = renderTemplate('sbt "testOnly {{suiteName}}"', {
    suiteName: 'com.example.MySuite'
  });

  assert.equal(runExpanded, 'sbt "runMain com.example.Main"');
  assert.equal(testExpanded, 'sbt "testOnly com.example.MySuite"');
});

test('FR-0011: default profile is auto-generated when none defined', () => {
  const defaultProfile = generateDefaultProfile('sbt');
  assert.equal(defaultProfile.name.startsWith('Default'), true);
  assert.equal(defaultProfile.buildTool, 'sbt');
  assert.equal(defaultProfile.runCommand.length > 0, true);
  assert.equal(defaultProfile.testCommand.length > 0, true);
});

test('FR-0011: profile command shaping applies working directory and pre-build command', () => {
  const command = applyProfileCommandShape('sbt "runMain com.example.Main"', {
    name: 'service-a',
    buildTool: 'sbt',
    workingDirectory: 'services/a',
    runCommand: 'sbt "runMain {{mainClass}}"',
    testCommand: 'sbt "testOnly {{suiteName}}"',
    envVars: { JAVA_OPTS: '-Xmx2g' },
    jvmOpts: ['-Xmx2g'],
    preBuildCommand: 'sbt compile'
  });

  assert.equal(command.includes('cd "services/a"'), true);
  assert.equal(command.includes('sbt compile'), true);
  assert.equal(command.includes('JAVA_OPTS='), true);
});

test('FR-0011: extension wires active profile into run/test command paths', () => {
  const source = readSource('src/extension.ts');
  assert.equal(source.includes('getActiveProfile: () => profileManager.getActiveProfile()'), true);
  assert.equal(source.includes('new ProfileManager'), true);
});

test('FR-0011: schema declares required profile fields for validation', () => {
  const schemaText = readSource('schema/scala-lite.schema.json');
  const schema = JSON.parse(schemaText) as {
    properties: {
      profiles: {
        items: {
          required: string[];
        };
      };
    };
  };

  const required = schema.properties.profiles.items.required;
  assert.equal(required.includes('name'), true);
  assert.equal(required.includes('buildTool'), true);
  assert.equal(required.includes('workingDirectory'), true);
  assert.equal(required.includes('runCommand'), true);
  assert.equal(required.includes('testCommand'), true);
  assert.equal(required.includes('envVars'), true);
  assert.equal(required.includes('jvmOpts'), true);
  assert.equal(required.includes('preBuildCommand'), true);
});
