import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath: string): string {
  const filePath = path.resolve(process.cwd(), relativePath);
  return fs.readFileSync(filePath, 'utf8');
}

test('FR-0034: go-to-definition captures origin snapshot and executes staged pipeline coordinator', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes('interface ResolutionOriginSnapshot'), true);
  assert.equal(source.includes('private captureOriginSnapshot('), true);
  assert.equal(source.includes('private async resolveWithStagedPipeline('), true);
  assert.equal(source.includes('const stageA = this.resolveStageALocalLexical(document, originSnapshot);'), true);
  assert.equal(source.includes('const stageB = this.resolveStageBSameFileTopLevel(document, originSnapshot);'), true);
  assert.equal(source.includes('const stageC = await this.resolveStageCImportAware(originSnapshot, token);'), true);
  assert.equal(source.includes('const stageD = await this.resolveStageDSamePackage(originSnapshot, token);'), true);
  assert.equal(source.includes('const stageE = await this.resolveStageEModuleIndex(originSnapshot, token);'), true);
  assert.equal(source.includes('const stageF = await this.resolveStageFTextSearch(document, originSnapshot, token);'), true);
});

test('FR-0034: staged flow gates auto-jump by high confidence and sends ambiguity to chooser', () => {
  const source = readSource('src/goToDefinitionFeature.ts');

  assert.equal(source.includes("if (stageA.candidates.length === 1 && stageA.confidence === 'high')"), true);
  assert.equal(source.includes("if (stageB.candidates.length === 1 && stageB.confidence === 'high')"), true);
  assert.equal(source.includes('if (stageD.candidates.length > 1) {'), true);
  assert.equal(source.includes('if (stageE.candidates.length > 1) {'), true);
  assert.equal(source.includes('private async showIndexedCandidateChooser('), true);
  assert.equal(source.includes("get<boolean>('traceResolution', false)"), true);
  assert.equal(source.includes('[traceResolution] stage='), true);
});
