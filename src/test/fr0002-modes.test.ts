import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import './vscode-mock';
import { getModeText, getModeDefinition, MODES } from '../modePresentation';
import {
  COMMAND_PICK_MODE,
  COMMAND_SWITCH_MODE_A,
  COMMAND_SWITCH_MODE_B,
  COMMAND_SWITCH_MODE_C
} from '../modeManager';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0002: mode label for A is correct', () => {
  assert.equal(getModeText('A'), '⚡ A');
});

test('FR-0002: mode label for B is correct', () => {
  assert.equal(getModeText('B'), '▶ B');
});

test('FR-0002: mode label for C is correct', () => {
  assert.equal(getModeText('C'), '🔍 C');
});

test('FR-0002: MODES array contains exactly three entries with descriptions and impact', () => {
  assert.equal(MODES.length, 3);
  for (const entry of MODES) {
    assert.ok(entry.mode, 'each mode must have a mode key');
    assert.ok(entry.text, 'each mode must have display text');
    assert.ok(entry.description, 'each mode must have a description');
    assert.ok(entry.impact, 'each mode must have an impact label');
  }
});

test('FR-0002: getModeDefinition returns matching definition for each mode', () => {
  const defA = getModeDefinition('A');
  assert.equal(defA.mode, 'A');
  assert.ok(defA.description.toLowerCase().includes('editing'));

  const defC = getModeDefinition('C');
  assert.equal(defC.mode, 'C');
  assert.ok(defC.description.toLowerCase().includes('index'));
});

test('FR-0002: command constants match package.json contributions', () => {
  const packageJson = readSource('package.json');
  assert.equal(COMMAND_SWITCH_MODE_A, 'scalaLite.switchModeA');
  assert.equal(COMMAND_SWITCH_MODE_B, 'scalaLite.switchModeB');
  assert.equal(COMMAND_SWITCH_MODE_C, 'scalaLite.switchModeC');
  assert.equal(COMMAND_PICK_MODE, 'scalaLite.pickWorkspaceMode');

  assert.ok(packageJson.includes(`"${COMMAND_SWITCH_MODE_A}"`));
  assert.ok(packageJson.includes(`"${COMMAND_SWITCH_MODE_B}"`));
  assert.ok(packageJson.includes(`"${COMMAND_SWITCH_MODE_C}"`));
});

test('FR-0002: ModeManager class is exported and constructable', () => {
  // Verify the module exports the class (import would fail if not)
  const { ModeManager } = require('../modeManager');
  assert.equal(typeof ModeManager, 'function');
});
